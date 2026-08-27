/**
 * Resume bytes → text: the first stage of the pipeline described in extract.ts.
 *
 * Zero dependencies, like the rest of core. DOCX is a ZIP holding an XML
 * document, and both `DecompressionStream` and `TextDecoder` are platform
 * APIs, so the whole format is readable without pulling in a parser — and it
 * runs unchanged in the side panel and in Node for tests.
 *
 * PDF is deliberately NOT attempted here. Extracting text from a PDF needs a
 * real layout engine (pdf.js), which must run in the panel or an offscreen
 * document because MV3 service workers have no `new Worker()`. Guessing at
 * PDF internals would produce plausible-looking garbage, and a resume parsed
 * from garbage invents facts — exactly what the product forbids. So an
 * unreadable format says so, and the caller offers the paste-text fallback.
 */

/** Formats this module can turn into text today. */
export type ResumeTextFormat = "plain" | "docx";

/** Why bytes could not be read, in terms the UI can explain to a user. */
export type ResumeTextFailure =
  | "pdf_unsupported"
  | "legacy_doc"
  | "unknown_format"
  | "empty";

export type ResumeTextResult =
  | { ok: true; format: ResumeTextFormat; text: string }
  | { ok: false; reason: ResumeTextFailure; message: string };

// ---------------------------------------------------------------------------
// Format sniffing — magic bytes, not the filename.
// ---------------------------------------------------------------------------

const startsWith = (bytes: Uint8Array, sig: number[]): boolean =>
  bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);

const PDF = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0]; // legacy .doc compound file

/**
 * Read a resume's bytes as text.
 *
 * Extensions lie and browsers disagree about MIME types for .docx, so the
 * decision is made on the leading bytes; `filename` only sharpens messages.
 */
export async function extractResumeText(
  bytes: Uint8Array,
  filename?: string,
): Promise<ResumeTextResult> {
  const name = filename === undefined ? "This file" : `"${filename}"`;

  if (bytes.length === 0) {
    return { ok: false, reason: "empty", message: `${name} is empty.` };
  }
  if (startsWith(bytes, PDF)) {
    return {
      ok: false,
      reason: "pdf_unsupported",
      message: `${name} is a PDF. Reading text out of PDFs isn't wired up yet — paste the text below instead.`,
    };
  }
  if (startsWith(bytes, OLE2)) {
    return {
      ok: false,
      reason: "legacy_doc",
      message: `${name} is a legacy .doc. Save it as .docx and upload again, or paste the text below.`,
    };
  }
  if (startsWith(bytes, ZIP)) {
    const text = await docxToText(bytes);
    if (text === undefined) {
      return {
        ok: false,
        reason: "unknown_format",
        message: `${name} is a zip, but not a Word document. Paste the text below instead.`,
      };
    }
    return finish(text, "docx", name);
  }

  const decoded = decodeUtf8(bytes);
  if (decoded === undefined) {
    return {
      ok: false,
      reason: "unknown_format",
      message: `${name} isn't a format LarpMaxer can read. Paste the text below instead.`,
    };
  }
  return finish(decoded, "plain", name);
}

/** A parse needs real prose; a handful of stray characters is not a resume. */
function finish(text: string, format: ResumeTextFormat, name: string): ResumeTextResult {
  const trimmed = text.trim();
  if (trimmed.length < 40) {
    return {
      ok: false,
      reason: "empty",
      message: `${name} has almost no readable text in it.`,
    };
  }
  return { ok: true, format, text: trimmed };
}

/**
 * Decode as UTF-8, rejecting binary.
 *
 * A non-fatal decode turns any byte soup into replacement characters, so the
 * result is checked for the markers of binary: NULs, and a high share of
 * replacement or control characters.
 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  if (text.includes("\u0000")) return undefined;
  // U+FFFD marks a failed decode; C0 controls beyond tab/newline/CR are binary.
  const bad = (text.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  return bad / Math.max(text.length, 1) > 0.05 ? undefined : text;
}

// ---------------------------------------------------------------------------
// DOCX = ZIP(word/document.xml).
// ---------------------------------------------------------------------------

const DOC_ENTRY = "word/document.xml";

/** Pull `word/document.xml` out of a .docx and flatten it to text. */
async function docxToText(zip: Uint8Array): Promise<string | undefined> {
  const entry = await readZipEntry(zip, DOC_ENTRY);
  return entry === undefined ? undefined : wordXmlToText(new TextDecoder("utf-8").decode(entry));
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number =>
  ((b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0);

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Read one named entry from a ZIP.
 *
 * Only what a .docx actually uses is supported: stored (0) and deflate (8),
 * no ZIP64, no encryption. Sizes come from the central directory because a
 * local header may carry zeroes when the writer used a data descriptor.
 */
async function readZipEntry(zip: Uint8Array, want: string): Promise<Uint8Array | undefined> {
  const eocd = findEocd(zip);
  if (eocd === undefined) return undefined;

  const count = u16(zip, eocd + 10);
  let at = u32(zip, eocd + 16);

  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || u32(zip, at) !== SIG_CENTRAL) return undefined;

    const method = u16(zip, at + 10);
    const compressedSize = u32(zip, at + 20);
    const nameLen = u16(zip, at + 28);
    const extraLen = u16(zip, at + 30);
    const commentLen = u16(zip, at + 32);
    const localAt = u32(zip, at + 42);
    const name = new TextDecoder("utf-8").decode(zip.subarray(at + 46, at + 46 + nameLen));

    if (name === want) return readLocal(zip, localAt, method, compressedSize);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

/** Slice an entry's data from its local header and inflate it if needed. */
async function readLocal(
  zip: Uint8Array,
  localAt: number,
  method: number,
  compressedSize: number,
): Promise<Uint8Array | undefined> {
  if (localAt + 30 > zip.length || u32(zip, localAt) !== SIG_LOCAL) return undefined;

  const dataAt = localAt + 30 + u16(zip, localAt + 26) + u16(zip, localAt + 28);
  const data = zip.subarray(dataAt, dataAt + compressedSize);
  if (data.length !== compressedSize) return undefined;

  if (method === 0) return data;
  if (method !== 8) return undefined;
  try {
    return await inflateRaw(data);
  } catch {
    return undefined;
  }
}

/** The end-of-central-directory record, searched backwards (it ends the file). */
function findEocd(zip: Uint8Array): number | undefined {
  // 22 bytes minimum, plus up to 64KB of trailing comment.
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= floor; i--) {
    if (u32(zip, i) === SIG_EOCD) return i;
  }
  return undefined;
}

/** Raw DEFLATE via the platform's own decompressor. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  // Write and read concurrently: awaiting the write first can deadlock on
  // backpressure, because nothing is draining the readable side yet.
  const written = (async () => {
    // TS 5.7+ distinguishes Uint8Array by its backing buffer; the view handed
    // to the stream here is always ArrayBuffer-backed.
    await writer.write(data as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await written;

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WordprocessingML → text.
// ---------------------------------------------------------------------------

/**
 * Flatten WordprocessingML to plain text.
 *
 * extract.ts reads structure from line breaks — headings, date ranges, bullets
 * — so paragraph and row boundaries have to survive as newlines. Everything
 * else is markup and goes away.
 */
export function wordXmlToText(xml: string): string {
  const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;

  return decodeXmlEntities(
    body
      // Drop anything whose text is not document content.
      .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, "")
      .replace(/<w:delText[\s\S]*?<\/w:delText>/g, "")
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, "\n")
      // Paragraph and table-row ends are the line structure extract.ts needs.
      .replace(/<\/w:(?:p|tr)>/g, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      // Out-of-range code points make fromCodePoint throw, and a malformed
      // entity must not take the whole parse down with it.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}
