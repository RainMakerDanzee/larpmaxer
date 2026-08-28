import { describe, expect, it } from "vitest";
import { itemsToLines, type PdfTextItem } from "../src/sidepanel/pdfLines.js";

/** Shorthand: a glyph run at (x, y). */
const at = (str: string, x: number, y: number, hasEOL = false): PdfTextItem => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  hasEOL,
});

describe("itemsToLines", () => {
  it("joins runs on one baseline and breaks on vertical movement", () => {
    const text = itemsToLines([
      at("Riley", 50, 700),
      at("Park", 90, 700),
      at("Senior Data Analyst", 50, 680),
    ]);
    expect(text).toBe("Riley Park\nSenior Data Analyst");
  });

  it("keeps the line structure a resume parser depends on", () => {
    const text = itemsToLines([
      at("WORK EXPERIENCE", 50, 600),
      at("Senior Data Analyst — Acme Pty Ltd", 50, 580),
      at("Mar 2022 - Present", 50, 564),
      at("- Rebuilt the weekly reporting pipeline", 60, 548),
    ]);
    expect(text.split("\n")).toEqual([
      "WORK EXPERIENCE",
      "Senior Data Analyst — Acme Pty Ltd",
      "Mar 2022 - Present",
      "- Rebuilt the weekly reporting pipeline",
    ]);
  });

  it("honours pdf.js's explicit end-of-line marks even without movement", () => {
    const text = itemsToLines([at("one", 50, 700, true), at("two", 50, 700)]);
    expect(text).toBe("one\ntwo");
  });

  it("ignores sub-tolerance baseline jitter within a line", () => {
    const text = itemsToLines([at("kerned", 50, 700), at("run", 92, 700.8)]);
    expect(text).toBe("kerned run");
  });

  it("does not double spaces the writer already placed", () => {
    const text = itemsToLines([at("Hello ", 50, 700), at("world", 80, 700)]);
    expect(text).toBe("Hello world");
  });

  it("drops empty items and produces no blank lines", () => {
    const text = itemsToLines([at("", 50, 700), at("only", 50, 680), at("", 50, 660)]);
    expect(text).toBe("only");
  });

  it("returns an empty string for a page with no text", () => {
    expect(itemsToLines([])).toBe("");
  });
});
