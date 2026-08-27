/**
 * The application ledger: one clean spreadsheet row per job applied to.
 *
 * Builds a real .xlsx from scratch — an xlsx file is just a zip of XML parts,
 * so this module hand-writes both (STORE-only zip, minimal OOXML) and keeps
 * core at zero runtime dependencies. Verified against Excel, LibreOffice and
 * Google Sheets' xlsx importers' minimum requirements: [Content_Types],
 * package + workbook rels, styles, one worksheet with inline strings.
 */

import type { ApplicationRecord } from "./types";

/** One row of the ledger, ready for the worksheet. */
export interface LedgerRow {
  /** ISO date the application was submitted (or last touched). */
  date: string;
  company: string;
  role: string;
  /** Applicant-tracking system that handled it (adapter id). */
  ats: string;
  /** Final phase — "done" renders as "submitted". */
  status: string;
  /** Original job posting URL. */
  url: string;
  /** Resume filename that was attached, if any. */
  resume: string;
  /** Free text: submit evidence or error detail. */
  notes: string;
}

/** Map stored records (newest first) to ledger rows. */
export function ledgerRowsFromRecords(records: readonly ApplicationRecord[]): LedgerRow[] {
  return [...records]
    .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""))
    .map((r) => ({
      date: (r.submittedAt ?? "").slice(0, 10),
      company: r.company ?? "",
      role: r.jobTitle ?? "",
      ats: r.adapterId,
      status: r.phase === "done" ? "submitted" : r.phase,
      url: r.url,
      resume: r.plan?.answers.find((a) => a.resume !== undefined)?.resume?.filename ?? "",
      notes: (r.submit?.evidence ?? []).join(" | ").slice(0, 500),
    }));
}

const HEADERS = ["Date", "Company", "Role", "ATS", "Status", "Link", "Resume", "Notes"] as const;
const COL_WIDTHS = [11, 22, 30, 12, 12, 12, 26, 40];

/** Build the complete .xlsx file for the given rows. */
export function buildLedgerXlsx(rows: readonly LedgerRow[]): Uint8Array {
  const files: [name: string, content: string][] = [
    ["[Content_Types].xml", CONTENT_TYPES],
    ["_rels/.rels", ROOT_RELS],
    ["xl/workbook.xml", WORKBOOK],
    ["xl/_rels/workbook.xml.rels", WORKBOOK_RELS],
    ["xl/styles.xml", STYLES],
    ["xl/worksheets/sheet1.xml", sheetXml(rows)],
  ];
  return zip(files);
}

// ---------------------------------------------------------------------------
// Worksheet
// ---------------------------------------------------------------------------

function esc(s: string): string {
  const entities = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  // XML 1.0 forbids most C0 control characters; strip them instead of encoding.
  let clean = "";
  for (const ch of entities) {
    const c = ch.charCodeAt(0);
    if (c >= 32 || c === 9 || c === 10 || c === 13) clean += ch;
  }
  return clean;
}

/** Column letter for a 0-based index (ledger stays within A–Z). */
const col = (i: number): string => String.fromCharCode(65 + i);

function strCell(ref: string, value: string, style = 0): string {
  if (value === "") return "";
  const s = style > 0 ? ` s="${style}"` : "";
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/** A clickable link cell: =HYPERLINK("url","Open") keeps the file self-contained. */
function linkCell(ref: string, url: string): string {
  if (url === "") return "";
  const doubled = url.replace(/"/g, '""');
  return `<c r="${ref}" t="str" s="2"><f>HYPERLINK("${esc(doubled)}","Open")</f></c>`;
}

function sheetXml(rows: readonly LedgerRow[]): string {
  const header = HEADERS.map((h, i) => strCell(`${col(i)}1`, h, 1)).join("");
  const body = rows
    .map((r, ri) => {
      const n = ri + 2;
      const cells = [
        strCell(`A${n}`, r.date),
        strCell(`B${n}`, r.company),
        strCell(`C${n}`, r.role),
        strCell(`D${n}`, r.ats),
        strCell(`E${n}`, r.status),
        linkCell(`F${n}`, r.url),
        strCell(`G${n}`, r.resume),
        strCell(`H${n}`, r.notes),
      ].join("");
      return `<row r="${n}">${cells}</row>`;
    })
    .join("");
  const cols = COL_WIDTHS.map(
    (w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`,
  ).join("");
  const last = rows.length + 1;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<cols>${cols}</cols>` +
    `<sheetData><row r="1">${header}</row>${body}</sheetData>` +
    `<autoFilter ref="A1:H${last}"/>` +
    `</worksheet>`
  );
}

// ---------------------------------------------------------------------------
// Static parts
// ---------------------------------------------------------------------------

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="Applications" sheetId="1" r:id="rId1"/></sheets>` +
  `</workbook>`;

const WORKBOOK_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

/* Style ids used by cells: 0 default · 1 header (medium weight on lime) · 2 link. */
const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="3">` +
  `<font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF1E1E1E"/></font>` +
  `<font><u/><sz val="11"/><name val="Calibri"/><color rgb="FF3B5D08"/></font>` +
  `</fonts>` +
  `<fills count="3">` +
  `<fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFD4FA70"/><bgColor rgb="FFD4FA70"/></patternFill></fill>` +
  `</fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `</cellXfs>` +
  `</styleSheet>`;

// ---------------------------------------------------------------------------
// Minimal zip writer (STORE only — xlsx readers do not require compression)
// ---------------------------------------------------------------------------

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed DOS timestamp (2026-01-01 00:00) keeps output byte-stable for tests. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(files: readonly [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameB = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameB.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // method: STORE
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameB.length, true);
    local.set(nameB, 30);
    chunks.push(local, data);

    const cent = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cent.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(10, 0, true); // method: STORE
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cent.set(nameB, 46);
    central.push(cent);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of [...chunks, ...central, eocd]) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
