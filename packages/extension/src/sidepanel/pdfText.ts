/**
 * PDF → text, in the side panel — the one extension context where pdf.js can
 * run (MV3 service workers have no `new Worker()`; the panel is a real page).
 *
 * This closes the gap core's resume/text.ts deliberately left open: core is
 * zero-dependency and refuses to guess at PDF internals, so the panel supplies
 * the real layout engine and hands the result to the same parse pipeline.
 */

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import {
  extractResumeText,
  type ResumeTextResult,
} from "@larpmaxer/core";
import { itemsToLines, type PdfTextItem } from "./pdfLines.js";

// The worker file is copied into sidepanel/ by the build; the panel's own
// pages (index.html, demo.html) live there too, so a relative URL resolves in
// both the extension and the demo without touching chrome.* APIs.
GlobalWorkerOptions.workerSrc = "pdf.worker.min.mjs";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

const isPdf = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && PDF_MAGIC.every((b, i) => bytes[i] === b);

/** Text of every page, in order, with line structure rebuilt from geometry. */
export async function pdfBytesToText(bytes: Uint8Array): Promise<string> {
  // pdf.js transfers the buffer to its worker; hand it a copy so the caller's
  // bytes (also used to store the resume) are not detached underneath it.
  const task = getDocument({ data: bytes.slice() });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      // Marked-content entries carry no str/transform; keep only glyph runs,
      // reshaped to the minimal PdfTextItem the line builder reads.
      const items: PdfTextItem[] = [];
      for (const entry of content.items) {
        const run = entry as { str?: unknown; transform?: unknown; hasEOL?: unknown };
        if (typeof run.str === "string" && Array.isArray(run.transform)) {
          items.push({
            str: run.str,
            transform: run.transform as number[],
            ...(run.hasEOL === true ? { hasEOL: true } : {}),
          });
        }
      }
      pages.push(itemsToLines(items));
    }
    return pages.filter((p) => p !== "").join("\n\n");
  } finally {
    // Destroying the loading task tears down the document and its worker copy.
    await task.destroy();
  }
}

/**
 * Read any resume file the panel is handed.
 *
 * PDFs go through pdf.js here; every other format goes through core's
 * zero-dependency reader. One entry point, one result shape.
 */
export async function readResumeBytes(
  bytes: Uint8Array,
  filename?: string,
): Promise<ResumeTextResult> {
  if (!isPdf(bytes)) return extractResumeText(bytes, filename);

  const name = filename === undefined ? "This PDF" : `"${filename}"`;
  try {
    const text = (await pdfBytesToText(bytes)).trim();
    if (text.length < 40) {
      return {
        ok: false,
        reason: "empty",
        message: `${name} has almost no selectable text — it may be a scan. Paste the text below instead.`,
      };
    }
    return { ok: true, format: "plain", text };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "unknown_format",
      message: `${name} could not be read (${detail.slice(0, 80)}). Paste the text below instead.`,
    };
  }
}
