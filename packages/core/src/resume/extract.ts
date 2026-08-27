/**
 * Resume → structured profile, without a server and without necessarily an LLM.
 *
 * The pipeline is deliberately split so each stage can fail independently and
 * the next one still has something to work with:
 *
 *   bytes → text        (DOCX/plain in resume/text.ts; PDF still needs pdf.js,
 *                        so the panel offers a paste-the-text fallback)
 *   text  → sections    (heuristic; this file)
 *   text  → contact     (regex; this file — email/phone/links approach ~99%)
 *   text  → experience  (heuristic date-range parsing; this file)
 *   text  → Profile     (LLM refinement when one is configured; the heuristic
 *                        result is the fallback and the floor, never discarded)
 *
 * Rule-based extraction plateaus well below an LLM on messy layouts, so the
 * heuristics here aim to be *right or silent* rather than complete: a field it
 * cannot read confidently is left empty for the user or the LLM to fill, which
 * matches the product's "never invent, ask instead" rule.
 */

import type { Education, Experience, Profile } from "../types.js";
import { emptyProfile } from "../profile.js";

/** What the heuristics could read from a resume, with nothing invented. */
export interface ParsedResume {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  links: { label: string; url: string }[];
  summary?: string;
  skills: string[];
  experience: Experience[];
  education: Education[];
  /** Section headings found, in document order — useful for diagnostics. */
  sections: string[];
  /** Raw text, kept so a later LLM pass can re-read the original. */
  raw: string;
}

// ---------------------------------------------------------------------------
// Contact details — the part regex genuinely does well.
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Phone numbers, international or local, tolerating spaces, dots, dashes and
 * bracketed area codes. Requires 8+ digits so years and postcodes do not match.
 */
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d[\d\s.-]{7,}\d/;

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s,;)<>\]]+|(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co)(?:\.[a-z]{2})?\/[^\s,;)<>\]]+)/gi;

/** Well-known profile hosts get a friendly label; anything else keeps its host. */
const LINK_LABELS: [test: RegExp, label: string][] = [
  [/linkedin\.com/i, "LinkedIn"],
  [/github\.com/i, "GitHub"],
  [/gitlab\.com/i, "GitLab"],
  [/behance\.net/i, "Behance"],
  [/dribbble\.com/i, "Dribbble"],
  [/medium\.com/i, "Medium"],
  [/stackoverflow\.com/i, "Stack Overflow"],
];

function labelForUrl(url: string): string {
  for (const [test, label] of LINK_LABELS) {
    if (test.test(url)) return label;
  }
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
}

/** Email, phone and profile links. Absent values stay absent — never guessed. */
export function extractContact(text: string): Pick<ParsedResume, "email" | "phone" | "links"> {
  const email = EMAIL_RE.exec(text)?.[0];
  // Search away from URLs so a phone-like run inside a link is not mistaken.
  const phoneSource = text.replace(URL_RE, " ");
  const phoneRaw = PHONE_RE.exec(phoneSource)?.[0]?.trim();
  const phone = phoneRaw !== undefined && countDigits(phoneRaw) >= 8 ? tidyPhone(phoneRaw) : undefined;

  const links: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;)]+$/, "");
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    if (seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    links.push({ label: labelForUrl(url), url: normalized });
  }

  return {
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
    links,
  };
}

const countDigits = (s: string): number => (s.match(/\d/g) ?? []).length;
const tidyPhone = (s: string): string => s.replace(/[\s.]+/g, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Name — the first meaningful line, guarded against headings and contact rows.
// ---------------------------------------------------------------------------

const NOT_A_NAME =
  /\b(resume|curriculum vitae|cv|profile|summary|contact|phone|email|address|linkedin|github)\b/i;

/**
 * The candidate's name, if the top of the document offers one confidently.
 *
 * Resumes overwhelmingly lead with the name, so we take the first short line
 * of the first block that is not a heading, an address, or a contact row.
 */
export function extractName(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of lines.slice(0, 6)) {
    if (NOT_A_NAME.test(line)) continue;
    if (EMAIL_RE.test(line) || /\d{4}/.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 5) continue;
    // A name line is mostly letters; bullets, pipes and slashes signal a header.
    if (/[|/•·@]/.test(line)) continue;
    if (!/^[\p{L}][\p{L}'’.-]*(\s+[\p{L}][\p{L}'’.-]*)+$/u.test(line)) continue;
    return line;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sections — the spine everything else hangs off.
// ---------------------------------------------------------------------------

/** Canonical section names and the headings that map to them. */
const SECTION_PATTERNS: [key: string, test: RegExp][] = [
  ["summary", /^(professional\s+)?(summary|profile|about( me)?|objective)\b/i],
  ["experience", /^(work\s+|professional\s+|employment\s+|relevant\s+)?(experience|history|employment)\b/i],
  ["education", /^(education|academic|qualifications?)\b/i],
  ["skills", /^(technical\s+|core\s+|key\s+)?(skills|competenc(y|ies)|technologies|capabilities)\b/i],
  ["projects", /^(selected\s+|personal\s+|key\s+)?projects?\b/i],
  ["certifications", /^(certifications?|licen[cs]es?|accreditations?)\b/i],
  ["awards", /^(awards?|honou?rs|achievements?)\b/i],
];

/** True when a line reads as a section heading rather than body text. */
function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  if (/[.;]$/.test(trimmed)) return false;
  const stripped = trimmed.replace(/[^\p{L}\s&/-]/gu, "").trim();
  if (stripped.length === 0) return false;
  return SECTION_PATTERNS.some(([, test]) => test.test(stripped));
}

function sectionKey(line: string): string | undefined {
  const stripped = line.trim().replace(/[^\p{L}\s&/-]/gu, "").trim();
  return SECTION_PATTERNS.find(([, test]) => test.test(stripped))?.[0];
}

/** Split a resume into `{ heading → body }`, preserving document order. */
export function splitSections(text: string): { key: string; heading: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const found: { key: string; heading: string; start: number }[] = [];
  lines.forEach((line, i) => {
    if (!isHeading(line)) return;
    const key = sectionKey(line);
    if (key !== undefined) found.push({ key, heading: line.trim(), start: i });
  });

  return found.map((section, i) => {
    const end = i + 1 < found.length ? found[i + 1]!.start : lines.length;
    return {
      key: section.key,
      heading: section.heading,
      body: lines.slice(section.start + 1, end).join("\n").trim(),
    };
  });
}

// ---------------------------------------------------------------------------
// Skills, experience, education.
// ---------------------------------------------------------------------------

/** Skills from a skills section: comma, pipe, bullet or newline separated. */
export function extractSkills(sectionBody: string): string[] {
  const parts = sectionBody
    .split(/[\n,;|•·]+/)
    .map((s) => s.replace(/^[-–—*\s]+/, "").trim())
    .filter((s) => s.length > 1 && s.length <= 40)
    // Prose lines are not skills; a skill is a short noun phrase.
    .filter((s) => s.split(/\s+/).length <= 5 && !/[.!?]$/.test(s));
  return Array.from(new Set(parts));
}

const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const DATE_RANGE_RE = new RegExp(
  `(${MONTH}\\.?\\s*)?((19|20)\\d{2})\\s*(?:-|–|—|to|until)\\s*((${MONTH}\\.?\\s*)?((19|20)\\d{2})|present|current|now)`,
  "i",
);

/**
 * Roles from an experience section.
 *
 * A role entry is anchored on its date range: the line carrying the range (or
 * the line above it) holds the title and employer. This is the single most
 * reliable structural cue in an otherwise free-form document.
 */
export function extractExperience(sectionBody: string): Experience[] {
  const lines = sectionBody.split(/\r?\n/).map((l) => l.trim());
  const roles: Experience[] = [];

  lines.forEach((line, i) => {
    const match = DATE_RANGE_RE.exec(line);
    if (match === null) return;

    const { start, end } = normalizeRange(match[0]);
    // Title/employer sit on the date line itself, or immediately above it.
    const dateLineRest = line.replace(match[0], " ").replace(/[|•·]+/g, " ").trim();
    const above = i > 0 ? lines[i - 1]!.trim() : "";
    const header = dateLineRest.length >= 3 ? dateLineRest : above;
    const { title, company } = splitTitleCompany(header);
    if (title === "" && company === "") return;

    // Bullets under the entry, up to the next role. A role is announced either
    // by its own dated line, or by a header line whose date sits on the line
    // BELOW it — so look ahead one line before claiming text as a highlight.
    const highlights: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (DATE_RANGE_RE.test(next)) break;
      if (DATE_RANGE_RE.test(lines[j + 1] ?? "")) break; // next line's header
      const bullet = next.replace(/^[-–—*•·]\s*/, "").trim();
      if (bullet.length > 12) highlights.push(bullet);
      if (highlights.length >= 8) break;
    }

    roles.push({ title, company, start, end, highlights });
  });

  return roles;
}

/** Split "Senior Analyst — Acme Pty Ltd" into its two halves, tolerating separators. */
function splitTitleCompany(header: string): { title: string; company: string } {
  const cleaned = header.replace(/\s{2,}/g, " ").trim();
  const parts = cleaned.split(/\s+(?:[—–-]|@|,|\bat\b)\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { title: parts[0]!, company: parts.slice(1).join(", ") };
  return { title: cleaned, company: "" };
}

/** Normalise a matched range to ISO-ish `YYYY-MM` / `present`. */
function normalizeRange(range: string): { start: string; end: string } {
  const halves = range.split(/\s*(?:-|–|—|to|until)\s*/i);
  return {
    start: normalizeDate(halves[0] ?? ""),
    end: normalizeDate(halves[1] ?? ""),
  };
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function normalizeDate(part: string): string {
  const text = part.trim().toLowerCase();
  if (/present|current|now/.test(text)) return "present";
  const year = /(19|20)\d{2}/.exec(text)?.[0];
  if (year === undefined) return "";
  const month = MONTHS[text.slice(0, 3)];
  return month !== undefined ? `${year}-${month}` : year;
}

/** Qualifications from an education section, one per dated or degree-ish line. */
export function extractEducation(sectionBody: string): Education[] {
  const lines = sectionBody.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 2);
  const degreeRe = /\b(bachelor|master|phd|doctorate|diploma|certificate|b\.?sc|m\.?sc|b\.?a\b|m\.?b\.?a)\b/i;
  const out: Education[] = [];

  lines.forEach((line, i) => {
    if (!degreeRe.test(line)) return;
    const year = /(19|20)\d{2}/.exec(line)?.[0] ?? /(19|20)\d{2}/.exec(lines[i + 1] ?? "")?.[0];
    const { title, company } = splitTitleCompany(line.replace(/(19|20)\d{2}.*$/, "").trim());
    out.push({
      qualification: title,
      institution: company || (lines[i + 1] ?? "").replace(/(19|20)\d{2}.*$/, "").trim(),
      ...(year !== undefined ? { year } : {}),
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Whole-document parse.
// ---------------------------------------------------------------------------

/** Run every heuristic over a resume's text. Nothing is invented; gaps stay empty. */
export function parseResume(text: string): ParsedResume {
  const sections = splitSections(text);
  const body = (key: string): string => sections.find((s) => s.key === key)?.body ?? "";

  const contact = extractContact(text);
  const name = extractName(text);
  const summaryBody = body("summary");
  const skillsBody = body("skills");
  const experienceBody = body("experience");
  const educationBody = body("education");

  return {
    ...(name !== undefined ? { name } : {}),
    ...contact,
    ...(summaryBody !== "" ? { summary: collapse(summaryBody).slice(0, 600) } : {}),
    skills: skillsBody !== "" ? extractSkills(skillsBody) : [],
    experience: experienceBody !== "" ? extractExperience(experienceBody) : [],
    education: educationBody !== "" ? extractEducation(educationBody) : [],
    sections: sections.map((s) => s.heading),
    raw: text,
  };
}

const collapse = (s: string): string => s.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();

/**
 * Merge a parse into a profile, filling only what the profile lacks.
 *
 * The user's own edits always win: this never overwrites a field they have
 * already filled, so re-importing a resume is safe.
 */
export function mergeIntoProfile(parsed: ParsedResume, existing?: Profile): Profile {
  const base = existing ?? emptyProfile();
  const keep = (current: string, incoming?: string): string =>
    current.trim() !== "" ? current : (incoming ?? "");

  return {
    ...base,
    name: keep(base.name, parsed.name),
    email: keep(base.email, parsed.email),
    phone: keep(base.phone, parsed.phone),
    location: keep(base.location, parsed.location),
    summary: keep(base.summary, parsed.summary),
    links: base.links.length > 0 ? base.links : parsed.links,
    skills: base.skills.length > 0 ? base.skills : parsed.skills,
    experience: base.experience.length > 0 ? base.experience : parsed.experience,
    education: base.education.length > 0 ? base.education : parsed.education,
  };
}
