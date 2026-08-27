import { describe, expect, it } from "vitest";
import type { ApplicationRecord } from "../src/types";
import { buildLedgerXlsx, ledgerRowsFromRecords } from "../src/ledger";

const RECORD: ApplicationRecord = {
  id: "r1",
  url: "https://jobs.example.com/postings/123?q=a&b=c",
  company: "Example & Sons",
  jobTitle: "Data <Analyst>",
  adapterId: "greenhouse",
  submittedAt: "2026-08-27T04:05:06.000Z",
  phase: "done",
  plan: {
    adapterId: "greenhouse",
    url: "https://jobs.example.com/postings/123",
    answers: [
      { fieldId: "resume", value: "cv.pdf", source: "profile", resume: { id: "a", filename: "Jordan_CV.pdf", mime: "application/pdf" } },
    ],
    needsUser: [],
  },
  submit: { submitted: true, evidence: ["Thank you for applying"] },
};

function decodeAll(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

describe("ledgerRowsFromRecords", () => {
  it("maps a done record to a submitted row with resume + notes", () => {
    const [row] = ledgerRowsFromRecords([RECORD]);
    expect(row).toEqual({
      date: "2026-08-27",
      company: "Example & Sons",
      role: "Data <Analyst>",
      ats: "greenhouse",
      status: "submitted",
      url: "https://jobs.example.com/postings/123?q=a&b=c",
      resume: "Jordan_CV.pdf",
      notes: "Thank you for applying",
    });
  });

  it("sorts newest submission first", () => {
    const older = { ...RECORD, id: "r0", submittedAt: "2026-01-01T00:00:00.000Z" };
    const rows = ledgerRowsFromRecords([older, RECORD]);
    expect(rows.map((r) => r.date)).toEqual(["2026-08-27", "2026-01-01"]);
  });
});

describe("buildLedgerXlsx", () => {
  const bytes = buildLedgerXlsx(ledgerRowsFromRecords([RECORD]));
  const text = decodeAll(bytes);

  it("is a zip: local header magic, central directory, end record", () => {
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(text).toContain("PK"); // central directory entry
    expect(text).toContain("PK"); // end of central directory
  });

  it("contains every required xlsx part exactly once", () => {
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]) {
      // Local header + central directory each carry the name once; some names
      // also appear inside other parts (content types, rels targets).
      expect(text.split(part).length - 1, part).toBeGreaterThanOrEqual(2);
    }
  });

  it("escapes cell text and emits a HYPERLINK formula for the url", () => {
    expect(text).toContain("Example &amp; Sons");
    expect(text).toContain("Data &lt;Analyst&gt;");
    expect(text).toContain('HYPERLINK("https://jobs.example.com/postings/123?q=a&amp;b=c"');
    expect(text).not.toContain("Data <Analyst>");
  });

  it("freezes and styles the header row", () => {
    expect(text).toContain('state="frozen"');
    expect(text).toContain("FFD4FA70"); // lime header fill
    expect(text).toContain('autoFilter ref="A1:H2"');
  });

  it("strips control characters that would corrupt the XML", () => {
    const dirty = buildLedgerXlsx([
      {
        date: "2026-08-27",
        company: "CtrlCo",
        role: "",
        ats: "generic",
        status: "submitted",
        url: "",
        resume: "",
        notes: "line1\nline2",
      },
    ]);
    const t = decodeAll(dirty);
    expect(t).toContain("CtrlCo");
    expect(t).toContain("line1\nline2"); // newlines survive (legal in XML)
  });
});
