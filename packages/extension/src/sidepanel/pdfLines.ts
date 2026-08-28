/**
 * pdf.js text items → the line-structured text extract.ts needs.
 *
 * A PDF has no paragraphs — only positioned glyph runs. The resume parser
 * reads structure from LINES (headings, date ranges, bullets), so this module
 * reconstructs them from geometry: a new line starts when pdf.js says so
 * (`hasEOL`) or when a run's baseline moves vertically by more than a
 * tolerance. Kept dependency-free so it unit-tests without loading pdf.js.
 */

/** The slice of a pdf.js `TextItem` this module reads. */
export interface PdfTextItem {
  str: string;
  /** PDF transform matrix; [4] is x, [5] is y (origin bottom-left). */
  transform: number[];
  hasEOL?: boolean;
}

/**
 * Rebuild lines from one page's text items.
 *
 * Items arrive in content order, which on single-column resumes is reading
 * order. Vertical movement beyond `tolerance` (in PDF units — roughly points)
 * starts a new line; runs on one baseline are joined, inserting a space only
 * where the writer did not already end or start one.
 */
export function itemsToLines(items: PdfTextItem[], tolerance = 2): string {
  const lines: string[] = [];
  let current = "";
  let lastY: number | undefined;

  for (const item of items) {
    const y = item.transform[5] ?? 0;
    const moved = lastY !== undefined && Math.abs(y - lastY) > tolerance;

    if (moved && current !== "") {
      lines.push(current);
      current = "";
    }

    if (item.str !== "") {
      if (current === "") {
        current = item.str;
      } else if (current.endsWith(" ") || item.str.startsWith(" ")) {
        current += item.str;
      } else {
        current += ` ${item.str}`;
      }
      lastY = y;
    }

    // pdf.js marks explicit line ends; trust it even without vertical movement.
    if (item.hasEOL === true && current !== "") {
      lines.push(current);
      current = "";
    }
  }

  if (current !== "") lines.push(current);
  return lines
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
}
