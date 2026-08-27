/**
 * Profile validation, construction, and Q&A-bank maintenance.
 *
 * Validators are hand-rolled by design (ARCHITECTURE: core has zero runtime
 * dependencies, no zod). Validation collects every problem before throwing so
 * the UI can show one complete, fixable list.
 */

import type { Profile, QAEntry } from "./types.js";

/** Error thrown by {@link validateProfile}; `errors` holds one message per problem. */
export class ProfileValidationError extends Error {
  /** Human-readable problems, e.g. `"email: expected a string, got number"`. */
  readonly errors: string[];

  constructor(errors: string[]) {
    super(
      `Invalid profile (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n` +
        errors.map((e) => `- ${e}`).join("\n"),
    );
    this.name = "ProfileValidationError";
    this.errors = errors;
  }
}

// Loose on purpose: catches pasted non-addresses without rejecting unusual-but-real mailboxes.
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
// Experience dates are documented as ISO YYYY-MM in types.ts.
const YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkString(v: unknown, path: string, errors: string[]): v is string {
  if (typeof v === "string") return true;
  errors.push(`${path}: expected a string, got ${describe(v)}`);
  return false;
}

function checkOptionalString(v: unknown, path: string, errors: string[]): void {
  if (v !== undefined && typeof v !== "string") {
    errors.push(`${path}: expected a string or undefined, got ${describe(v)}`);
  }
}

function checkStringArray(v: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected an array, got ${describe(v)}`);
    return;
  }
  v.forEach((item, i) => void checkString(item, `${path}[${i}]`, errors));
}

function checkObjectArray(
  v: unknown,
  path: string,
  errors: string[],
  each: (item: Record<string, unknown>, itemPath: string) => void,
): void {
  if (!Array.isArray(v)) {
    errors.push(`${path}: expected an array, got ${describe(v)}`);
    return;
  }
  v.forEach((item, i) => {
    const itemPath = `${path}[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${itemPath}: expected an object, got ${describe(item)}`);
      return;
    }
    each(item, itemPath);
  });
}

/**
 * Validate an untrusted value as a {@link Profile}: returns the same object
 * (now typed) or throws {@link ProfileValidationError} listing every problem
 * found. Unknown extra keys are ignored for forward compatibility.
 */
export function validateProfile(p: unknown): Profile {
  if (!isRecord(p)) {
    throw new ProfileValidationError([`profile: expected an object, got ${describe(p)}`]);
  }
  const errors: string[] = [];

  for (const key of [
    "name",
    "email",
    "phone",
    "location",
    "workRights",
    "noticePeriod",
    "summary",
  ] as const) {
    checkString(p[key], key, errors);
  }
  if (typeof p.email === "string" && p.email !== "" && !EMAIL_RE.test(p.email)) {
    errors.push(`email: "${p.email}" does not look like an email address`);
  }
  if (typeof p.needsSponsorship !== "boolean") {
    errors.push(`needsSponsorship: expected a boolean, got ${describe(p.needsSponsorship)}`);
  }
  checkOptionalString(p.salary, "salary", errors);

  checkObjectArray(p.links, "links", errors, (link, path) => {
    checkString(link.label, `${path}.label`, errors);
    checkString(link.url, `${path}.url`, errors);
  });

  checkStringArray(p.skills, "skills", errors);

  checkObjectArray(p.experience, "experience", errors, (exp, path) => {
    checkString(exp.title, `${path}.title`, errors);
    checkString(exp.company, `${path}.company`, errors);
    if (checkString(exp.start, `${path}.start`, errors) && exp.start !== "" && !YEAR_MONTH_RE.test(exp.start)) {
      errors.push(`${path}.start: expected YYYY-MM, got "${exp.start}"`);
    }
    if (
      checkString(exp.end, `${path}.end`, errors) &&
      exp.end !== "" &&
      !YEAR_MONTH_RE.test(exp.end) &&
      !/^present$/i.test(exp.end)
    ) {
      errors.push(`${path}.end: expected YYYY-MM or "present", got "${exp.end}"`);
    }
    checkOptionalString(exp.location, `${path}.location`, errors);
    checkStringArray(exp.highlights, `${path}.highlights`, errors);
  });

  checkObjectArray(p.education, "education", errors, (edu, path) => {
    checkString(edu.institution, `${path}.institution`, errors);
    checkString(edu.qualification, `${path}.qualification`, errors);
    checkOptionalString(edu.year, `${path}.year`, errors);
    checkOptionalString(edu.notes, `${path}.notes`, errors);
  });

  checkObjectArray(p.qaBank, "qaBank", errors, (entry, path) => {
    checkString(entry.question, `${path}.question`, errors);
    checkString(entry.answer, `${path}.answer`, errors);
    if (typeof entry.approved !== "boolean") {
      errors.push(`${path}.approved: expected a boolean, got ${describe(entry.approved)}`);
    }
    if (typeof entry.uses !== "number" || !Number.isInteger(entry.uses) || entry.uses < 0) {
      const got = typeof entry.uses === "number" ? String(entry.uses) : describe(entry.uses);
      errors.push(`${path}.uses: expected a non-negative integer, got ${got}`);
    }
  });

  checkObjectArray(p.resumes, "resumes", errors, (resume, path) => {
    checkString(resume.id, `${path}.id`, errors);
    checkString(resume.filename, `${path}.filename`, errors);
    checkString(resume.mime, `${path}.mime`, errors);
    checkOptionalString(resume.tag, `${path}.tag`, errors);
  });

  if (errors.length > 0) throw new ProfileValidationError(errors);
  return p as unknown as Profile;
}

/** A blank but structurally valid {@link Profile} — the starting point for intake. */
export function emptyProfile(): Profile {
  return {
    name: "",
    email: "",
    phone: "",
    location: "",
    links: [],
    workRights: "",
    needsSponsorship: false,
    noticePeriod: "",
    summary: "",
    skills: [],
    experience: [],
    education: [],
    qaBank: [],
    resumes: [],
  };
}

// Words that carry no meaning when matching questions to saved answers.
// Interrogatives (why/what/how/when/where) are deliberately KEPT — they
// distinguish "why do you want this job" from "what do you want from this job".
const FILLER_WORDS = new Set([
  "a", "an", "the",
  "am", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "having",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "i", "me", "my", "we", "us", "our", "you", "your", "yours",
  "they", "them", "their", "it", "its",
  "to", "of", "in", "on", "at", "by", "for", "with", "from", "as",
  "and", "or", "if", "any", "please",
]);

/**
 * Canonical form of a screening question for fuzzy lookup: lowercased, with
 * punctuation and filler words removed; "" when nothing meaningful is left.
 */
export function normalizeQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[’']/g, "") // "what's" -> "whats", not "what s"
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !FILLER_WORDS.has(t))
    .join(" ");
}

// Dedupe key: normalized question, falling back to the raw trimmed text for
// questions that normalize to nothing (e.g. pure punctuation).
function qaKey(question: string): string {
  return normalizeQuestion(question) || question.trim().toLowerCase();
}

/**
 * Add `entry` to the profile's Q&A bank, deduplicating by normalized question.
 * Pure: returns a new Profile, mutating neither input. A duplicate replaces
 * the existing entry in place (new wording/answer/approved win) but keeps the
 * higher `uses` count so re-answering never resets usage history.
 */
/**
 * Remember a question a form asked that nobody has answered yet.
 *
 * The bank is how LarpMaxer stops asking twice, but until now it only grew
 * when the user answered in the moment. Anything skipped was forgotten, so the
 * same question came back on the next posting. Recording it unanswered lets
 * the user fill it in later, at leisure, and turns the bank into a picture of
 * what real forms actually ask.
 *
 * Strictly additive: an existing entry is never touched, so this can never
 * overwrite an answer the user already gave. Unapproved entries are invisible
 * to `qaAnswer`, so a blank placeholder is never filled into a form.
 */
export function recordOpenQuestion(profile: Profile, question: string): Profile {
  const text = question.trim();
  if (text === "") return profile;
  const key = qaKey(text);
  if (profile.qaBank.some((existing) => qaKey(existing.question) === key)) return profile;
  return {
    ...profile,
    qaBank: [...profile.qaBank, { question: text, answer: "", approved: false, uses: 0 }],
  };
}

/** Record several questions at once, skipping any the bank already holds. */
export function recordOpenQuestions(profile: Profile, questions: string[]): Profile {
  return questions.reduce(recordOpenQuestion, profile);
}

/** A profile field the user has not filled in, named the way the editor names it. */
export interface ProfileGap {
  /** Field label as shown in the Profile tab. */
  label: string;
  /** True when a fill will usually stall without it. */
  important: boolean;
}

/**
 * Which parts of the profile are still empty.
 *
 * A resume fills contact details and history well and says nothing about work
 * rights, notice period or salary — the things almost every application asks
 * and no CV contains. Naming those gaps turns "the import missed things" into
 * a short, finishable list.
 */
export function profileGaps(profile: Profile): ProfileGap[] {
  const blank = (s: string | undefined): boolean => (s ?? "").trim() === "";
  const gaps: ProfileGap[] = [];

  const add = (label: string, missing: boolean, important = true): void => {
    if (missing) gaps.push({ label, important });
  };

  add("Full name", blank(profile.name));
  add("Email", blank(profile.email));
  add("Phone", blank(profile.phone));
  add("Location", blank(profile.location));
  add("Work rights", blank(profile.workRights));
  add("Notice period", blank(profile.noticePeriod));
  add("Resume file", profile.resumes.length === 0);
  add("Professional summary", blank(profile.summary), false);
  add("Skills", profile.skills.length === 0, false);
  add("Experience", profile.experience.length === 0, false);
  add("Education", profile.education.length === 0, false);
  add("Salary expectation", blank(profile.salary), false);
  add("Links", profile.links.length === 0, false);

  return gaps;
}

export function mergeQaEntry(profile: Profile, entry: QAEntry): Profile {
  const key = qaKey(entry.question);
  const qaBank = profile.qaBank.slice();
  const at = qaBank.findIndex((existing) => qaKey(existing.question) === key);
  if (at === -1) {
    qaBank.push({ ...entry });
  } else {
    const existingUses = qaBank[at]?.uses ?? 0;
    qaBank[at] = { ...entry, uses: Math.max(existingUses, entry.uses) };
  }
  return { ...profile, qaBank };
}
