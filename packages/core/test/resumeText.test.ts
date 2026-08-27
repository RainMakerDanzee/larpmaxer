import { describe, expect, it } from "vitest";
import { extractResumeText, wordXmlToText } from "../src/resume/text.js";
import { mergeIntoProfile, parseResume } from "../src/resume/extract.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------
// A real .docx, built here so the reader is tested against actual ZIP bytes
// rather than a mock of one.
// ---------------------------------------------------------------------------

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  const written = (async () => {
    await writer.write(data as Uint8Array<ArrayBuffer>);
    await writer.close();
  })();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await written;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

interface ZipEntry {
  name: string;
  body: string;
  /** 0 = stored, 8 = deflate. Both appear in .docx files in the wild. */
  method: 0 | 8;
}

/**
 * Minimal ZIP writer. CRCs are left zero — the reader under test ignores them,
 * as it only needs the bytes, never integrity of an archive the user just made.
 */
async function makeZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = utf8(e.name);
    const raw = utf8(e.body);
    const data = e.method === 8 ? await deflateRaw(raw) : raw;

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, e.method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, e.method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, eocd];
  const zip = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    zip.set(p, at);
    at += p.length;
  }
  return zip;
}

/** Wrap lines as WordprocessingML paragraphs, the way Word actually emits them. */
const wordDoc = (paragraphs: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
    .map((p) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("")}<w:sectPr/></w:body></w:document>`;

const RESUME_LINES = [
  "Riley Park",
  "Sydney, NSW &#183; riley.park@example.com &#183; +61 400 000 000",
  "linkedin.com/in/rileypark",
  "",
  "PROFESSIONAL SUMMARY",
  "Data analyst who automates the boring parts.",
  "",
  "TECHNICAL SKILLS",
  "Python, SQL, Power BI, dbt, Airflow",
  "",
  "WORK EXPERIENCE",
  "Senior Data Analyst &#8212; Acme Pty Ltd",
  "Mar 2022 - Present",
  "- Rebuilt the weekly reporting pipeline, cutting runtime from 6 hours to 20 minutes.",
  "",
  "EDUCATION",
  "Bachelor of Information Technology &#8212; Macquarie University",
  "2018",
];

const docxOf = async (paragraphs: string[], method: 0 | 8 = 8): Promise<Uint8Array> =>
  makeZip([
    { name: "[Content_Types].xml", body: "<Types/>", method: 0 },
    { name: "word/document.xml", body: wordDoc(paragraphs), method },
  ]);

// ---------------------------------------------------------------------------

describe("extractResumeText — plain text", () => {
  it("reads a .txt resume", async () => {
    const res = await extractResumeText(utf8(RESUME_LINES.join("\n").replace(/&#\d+;/g, "-")), "cv.txt");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.format).toBe("plain");
    expect(res.text).toContain("riley.park@example.com");
  });

  it("strips a UTF-8 BOM so the first line is still the name", async () => {
    const res = await extractResumeText(utf8(`﻿Riley Park\n${"x".repeat(60)}`), "cv.txt");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.startsWith("Riley Park")).toBe(true);
  });
});

describe("extractResumeText — docx", () => {
  it("reads a deflated .docx", async () => {
    const res = await extractResumeText(await docxOf(RESUME_LINES), "cv.docx");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.format).toBe("docx");
    expect(res.text).toContain("riley.park@example.com");
    expect(res.text).toContain("WORK EXPERIENCE");
  });

  it("reads a stored (uncompressed) .docx", async () => {
    const res = await extractResumeText(await docxOf(RESUME_LINES, 0), "cv.docx");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.format).toBe("docx");
    expect(res.text).toContain("Macquarie University");
  });

  it("keeps each paragraph on its own line, which the parser reads as structure", async () => {
    const res = await extractResumeText(await docxOf(["Riley Park", "PROFESSIONAL SUMMARY", "Analyst who ships things properly."]), "cv.docx");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.split("\n")[0]).toBe("Riley Park");
    expect(res.text).toContain("\nPROFESSIONAL SUMMARY\n");
  });

  it("rejects a zip that is not a Word document", async () => {
    const zip = await makeZip([{ name: "notes.txt", body: "hello there", method: 8 }]);
    const res = await extractResumeText(zip, "archive.zip");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unknown_format");
  });
});

describe("extractResumeText — formats it will not guess at", () => {
  it("refuses a PDF and points at the paste fallback", async () => {
    const res = await extractResumeText(utf8("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>"), "cv.pdf");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("pdf_unsupported");
    expect(res.message).toContain("paste");
  });

  it("names a legacy .doc for what it is", async () => {
    const ole = new Uint8Array(200);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const res = await extractResumeText(ole, "cv.doc");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("legacy_doc");
  });

  it("rejects binary rather than returning mojibake", async () => {
    const junk = new Uint8Array(500).map((_, i) => (i * 37) % 256);
    const res = await extractResumeText(junk, "cv.bin");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("unknown_format");
  });

  it("reports an empty file as empty", async () => {
    const res = await extractResumeText(new Uint8Array(0), "cv.txt");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("empty");
  });

  it("treats a file with almost no text as empty rather than parsing it", async () => {
    const res = await extractResumeText(utf8("hi"), "cv.txt");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("empty");
  });
});

describe("wordXmlToText", () => {
  it("turns paragraphs, breaks and tabs into whitespace", () => {
    const xml = "<w:body><w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Two</w:t><w:br/><w:t>Three</w:t><w:tab/><w:t>Four</w:t></w:r></w:p></w:body>";
    expect(wordXmlToText(xml)).toBe("One\nTwo\nThree\tFour");
  });

  it("decodes named and numeric entities", () => {
    const xml = "<w:body><w:p><w:r><w:t>R&amp;D &#8212; 100&#x25; &lt;fast&gt;</w:t></w:r></w:p></w:body>";
    expect(wordXmlToText(xml)).toBe("R&D — 100% <fast>");
  });

  it("leaves a malformed entity alone instead of throwing", () => {
    const xml = "<w:body><w:p><w:r><w:t>Cost &#99999999; and &notreal; stay put</w:t></w:r></w:p></w:body>";
    expect(wordXmlToText(xml)).toBe("Cost &#99999999; and &notreal; stay put");
  });

  it("drops field instructions and deleted text, which are not document content", () => {
    const xml = "<w:body><w:p><w:r><w:instrText>HYPERLINK http://x</w:instrText><w:t>Visible</w:t></w:r></w:p></w:body>";
    expect(wordXmlToText(xml)).toBe("Visible");
  });

  it("puts each table row on its own line", () => {
    const xml = "<w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Skills</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Python</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>";
    expect(wordXmlToText(xml).split("\n").filter((l) => l !== "")).toEqual(["Skills", "Python"]);
  });
});

describe("docx to profile, end to end", () => {
  it("turns an uploaded .docx into a filled profile", async () => {
    const res = await extractResumeText(await docxOf(RESUME_LINES), "cv.docx");
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const profile = mergeIntoProfile(parseResume(res.text));
    expect(profile.name).toBe("Riley Park");
    expect(profile.email).toBe("riley.park@example.com");
    expect(profile.skills).toContain("Python");
    expect(profile.experience[0]?.title).toBe("Senior Data Analyst");
    expect(profile.experience[0]?.company).toBe("Acme Pty Ltd");
    expect(profile.education[0]?.institution).toBe("Macquarie University");
  });

  it("never overwrites what the user already typed", async () => {
    const res = await extractResumeText(await docxOf(RESUME_LINES), "cv.docx");
    if (!res.ok) throw new Error("expected readable docx");

    const existing = { ...mergeIntoProfile(parseResume("")), name: "Daniyal Ahmed" };
    const merged = mergeIntoProfile(parseResume(res.text), existing);
    expect(merged.name).toBe("Daniyal Ahmed");
    expect(merged.email).toBe("riley.park@example.com");
  });
});
