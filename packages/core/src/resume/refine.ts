/**
 * LLM refinement of a heuristic resume parse.
 *
 * The heuristics in extract.ts are right-or-silent, which makes them safe and
 * incomplete: they read a conventional resume well and give up on anything
 * with an unusual layout. A model reads layout far better, so this pass hands
 * it the resume text plus what the heuristics found and takes the corrections.
 *
 * Two rules keep that safe, and both are enforced here rather than asked for
 * in the prompt, because a prompt is a request and this is a guarantee:
 *
 * 1. GROUNDED. Every fact the model returns must appear in the resume text.
 *    A name, employer, title, skill or institution that is not in the document
 *    is discarded and the heuristic's value stands. The model may therefore
 *    select, split and organise what the resume says — it cannot add to it.
 *    Dates are the exception: they are normalised ("Mar 2022" to "2022-03"),
 *    so they are checked for shape instead of for presence.
 *
 * 2. NEVER WORSE. Any failure — a provider error, unparseable JSON, a field of
 *    the wrong type, an ungrounded value — falls back to the heuristic result
 *    for that field. Scalars and lists are only ever improved: skills and links
 *    are unioned, so a terse reply cannot delete what was already read.
 *
 * Experience and education are the deliberate exception: they are REPLACED by
 * a valid non-empty reply rather than merged. Restructuring is the whole point
 * for those two — the heuristics routinely fold a title, employer and date
 * range into one mangled entry, and there is no key by which a corrected role
 * can be matched to the broken one it supersedes. A reply that is empty or
 * entirely ungrounded still leaves the heuristic list untouched.
 */

import type { Education, Experience, LlmMessage, LlmProvider } from "../types.js";
import type { ParsedResume } from "./extract.js";

/** Resumes are long, and the reply restates much of one as JSON. */
const MAX_REFINE_TOKENS = 4000;

/**
 * Refine a heuristic parse with an LLM, returning a result that is never worse
 * than the one passed in. Never throws: a failed refinement returns `heuristic`.
 */
export async function refineResume(
  heuristic: ParsedResume,
  provider: LlmProvider,
): Promise<ParsedResume> {
  let raw: string;
  try {
    raw = await provider.complete(buildRefineMessages(heuristic), {
      maxTokens: MAX_REFINE_TOKENS,
    });
  } catch {
    // A provider that is down, rate-limited or misconfigured must not cost the
    // user the parse they already had.
    return heuristic;
  }

  const parsed = parseJsonObject(raw);
  return parsed === undefined ? heuristic : applyRefinement(heuristic, parsed);
}

// ---------------------------------------------------------------------------
// Prompt.
// ---------------------------------------------------------------------------

/** Messages asking the model to correct a parse using only the resume text. */
export function buildRefineMessages(heuristic: ParsedResume): LlmMessage[] {
  return [
    { role: "system", content: REFINE_SYSTEM },
    {
      role: "user",
      content: [
        "Resume text:",
        "---",
        heuristic.raw,
        "---",
        "",
        "What a rule-based parser read from it (it is conservative and often incomplete):",
        JSON.stringify(strippedForPrompt(heuristic), null, 2),
        "",
        "Return the corrected JSON.",
      ].join("\n"),
    },
  ];
}

const REFINE_SYSTEM = [
  "You extract structured data from a resume. The resume text is the only source of truth.",
  "",
  "Rules, in priority order:",
  "1. Use ONLY what the resume text says. Never invent or infer an employer, title, date, skill, qualification or contact detail that is not written in it. Values that are not in the text are discarded by the caller anyway.",
  "2. Omit any field you cannot read confidently. An absent field keeps the rule-based value; a wrong one is worse than none.",
  "3. Copy names, employers, titles, skills and institutions verbatim from the resume, character for character.",
  "4. Normalise dates only: `start` and `end` as YYYY-MM (or YYYY when no month is given), and `end` as \"present\" for a current role.",
  "5. Reply with a single JSON object and nothing else. No markdown, no commentary.",
  "",
  "Shape:",
  JSON.stringify(
    {
      name: "string",
      email: "string",
      phone: "string",
      location: "string",
      summary: "string",
      skills: ["string"],
      links: [{ label: "string", url: "string" }],
      experience: [
        {
          title: "string",
          company: "string",
          start: "YYYY-MM",
          end: "YYYY-MM | present",
          location: "string (optional)",
          highlights: ["string"],
        },
      ],
      education: [
        {
          institution: "string",
          qualification: "string",
          year: "string (optional)",
          notes: "string (optional)",
        },
      ],
    },
    null,
    2,
  ),
].join("\n");

/** The prompt shows the parse, not the raw text twice, nor diagnostics. */
function strippedForPrompt(p: ParsedResume): Omit<ParsedResume, "raw" | "sections"> {
  const { raw: _raw, sections: _sections, ...rest } = p;
  return rest;
}

// ---------------------------------------------------------------------------
// Reply parsing.
// ---------------------------------------------------------------------------

/**
 * Read the reply as a JSON object, tolerating the decoration models add:
 * a ```json fence, or prose either side of the object.
 */
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1];
  const candidate = (fenced ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(candidate.slice(start, end + 1));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

// ---------------------------------------------------------------------------
// Grounding: nothing survives that the resume does not say.
// ---------------------------------------------------------------------------

/** Lowercase, collapse whitespace, and flatten the dash and quote variants. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Digits only — a phone number may be reformatted without being changed. */
const digits = (s: string): string => s.replace(/\D/g, "");

/**
 * Is `value` actually in the resume?
 *
 * Leading/trailing punctuation is ignored so a bullet the model quotes without
 * its "- " still matches the line it came from.
 */
function grounded(haystack: string, value: string): boolean {
  const needle = normalize(value).replace(/^[-*\u2022\s]+/, "").replace(/[.,;:]+$/, "");
  return needle.length > 0 && haystack.includes(needle);
}

/** Keep `incoming` only when the resume supports it; otherwise keep `current`. */
function groundedField(
  haystack: string,
  incoming: string | undefined,
  current: string | undefined,
): string | undefined {
  if (incoming === undefined) return current;
  return grounded(haystack, incoming) ? incoming : current;
}

/** ISO-ish month, bare year, or the sentinel for a current role. */
const isDate = (s: string): boolean => /^\d{4}(-\d{2})?$/.test(s) || s.toLowerCase() === "present";

// ---------------------------------------------------------------------------
// Merge.
// ---------------------------------------------------------------------------

/** Apply a validated reply over the heuristic parse, field by field. */
function applyRefinement(
  heuristic: ParsedResume,
  reply: Record<string, unknown>,
): ParsedResume {
  const hay = normalize(heuristic.raw);
  const out: ParsedResume = { ...heuristic };

  const name = groundedField(hay, str(reply.name), heuristic.name);
  if (name !== undefined) out.name = name;

  // Email and phone have exact forms, so they are compared on their own terms
  // rather than as free text.
  const email = str(reply.email);
  if (email !== undefined && hay.includes(email.toLowerCase())) out.email = email;

  const phone = str(reply.phone);
  if (phone !== undefined && digits(phone).length >= 8 && digits(heuristic.raw).includes(digits(phone))) {
    out.phone = phone;
  }

  const location = groundedField(hay, str(reply.location), heuristic.location);
  if (location !== undefined) out.location = location;

  const summary = groundedField(hay, str(reply.summary), heuristic.summary);
  if (summary !== undefined) out.summary = summary;

  const skills = refineSkills(hay, reply.skills, heuristic.skills);
  if (skills.length > 0) out.skills = skills;

  const links = refineLinks(hay, reply.links, heuristic.links);
  if (links.length > 0) out.links = links;

  const experience = refineExperience(hay, reply.experience);
  if (experience.length > 0) out.experience = experience;

  const education = refineEducation(hay, reply.education);
  if (education.length > 0) out.education = education;

  return out;
}

/**
 * Skills are unioned, not replaced.
 *
 * The heuristics only read the skills section; a model also finds the tools
 * named inside role bullets. Both are grounded in the same document, so taking
 * both can only improve the list — and a model that returns a short list can
 * never delete skills the user actually has.
 */
function refineSkills(hay: string, incoming: unknown, current: string[]): string[] {
  if (!Array.isArray(incoming)) return current;
  const found = incoming
    .map(str)
    .filter((s): s is string => s !== undefined && grounded(hay, s));
  return dedupe([...current, ...found]);
}

function refineLinks(
  hay: string,
  incoming: unknown,
  current: ParsedResume["links"],
): ParsedResume["links"] {
  if (!Array.isArray(incoming)) return current;
  const merged = [...current];
  const seen = new Set(current.map((l) => normalize(l.url)));

  for (const item of incoming) {
    if (!isRecord(item)) continue;
    const url = str(item.url);
    const label = str(item.label);
    if (url === undefined || label === undefined) continue;
    // Match on the URL without its scheme: resumes rarely write "https://".
    if (!grounded(hay, url.replace(/^https?:\/\//, ""))) continue;
    if (seen.has(normalize(url))) continue;
    seen.add(normalize(url));
    merged.push({ label, url });
  }
  // Unioned for the same reason as skills: a model's shorter list must not
  // delete a profile link the heuristics already read correctly.
  return merged;
}

/**
 * Roles are rebuilt rather than merged.
 *
 * A role is only kept when its employer, title and dates all check out, so a
 * partially-invented entry is dropped whole instead of being half-trusted.
 */
function refineExperience(hay: string, incoming: unknown): Experience[] {
  if (!Array.isArray(incoming)) return [];
  const kept: Experience[] = [];

  for (const item of incoming) {
    if (!isRecord(item)) continue;
    const title = str(item.title);
    const company = str(item.company);
    const start = str(item.start);
    const end = str(item.end);
    if (title === undefined || company === undefined || start === undefined || end === undefined) {
      continue;
    }
    if (!grounded(hay, title) || !grounded(hay, company)) continue;
    if (!isDate(start) || !isDate(end)) continue;

    const highlights = Array.isArray(item.highlights)
      ? item.highlights
          .map(str)
          .filter((h): h is string => h !== undefined && grounded(hay, h))
      : [];

    const role: Experience = { title, company, start, end: end.toLowerCase() === "present" ? "present" : end, highlights };
    const location = str(item.location);
    if (location !== undefined && grounded(hay, location)) role.location = location;
    kept.push(role);
  }
  return kept;
}

function refineEducation(hay: string, incoming: unknown): Education[] {
  if (!Array.isArray(incoming)) return [];
  const kept: Education[] = [];

  for (const item of incoming) {
    if (!isRecord(item)) continue;
    const institution = str(item.institution);
    const qualification = str(item.qualification);
    if (institution === undefined || qualification === undefined) continue;
    if (!grounded(hay, institution) || !grounded(hay, qualification)) continue;

    const entry: Education = { institution, qualification };
    const year = str(item.year);
    if (year !== undefined && /^\d{4}$/.test(year) && hay.includes(year)) entry.year = year;
    const notes = str(item.notes);
    if (notes !== undefined && grounded(hay, notes)) entry.notes = notes;
    kept.push(entry);
  }
  return kept;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = normalize(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
