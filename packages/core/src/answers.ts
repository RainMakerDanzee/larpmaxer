/**
 * Field → answer resolution (ARCHITECTURE data-flow step 3). Order per field:
 *
 *   1. direct profile mapping (identity, links, work rights, sponsorship,
 *      notice, salary, resume files)
 *   2. Q&A bank fuzzy match (approved entries only, token overlap >= 0.6)
 *   3. the optional LLM delegate (used only when it reports confidence)
 *   4. queue as an OpenQuestion for the user
 *
 * Pure over its inputs: the profile is never mutated. QA `uses` counters are
 * the extension's to bump (via mergeQaEntry) after a successful fill.
 */

import type {
  FieldKind,
  FormField,
  OpenQuestion,
  Profile,
  QAEntry,
  ResolvedAnswer,
  ResumeRef,
} from "./types.js";
import { normalizeQuestion } from "./profile.js";

/** LLM hook: drafts an answer for one field from profile evidence, or declines with null. */
export type AnswerDelegate = (
  field: FormField,
  profile: Profile,
) => Promise<{ value: string; confident: boolean } | null>;

/** Outcome of {@link resolveAnswers}: every input field lands in exactly one list. */
export interface ResolutionResult {
  /** Fields the engine answered, in input order. */
  answers: ResolvedAnswer[];
  /** Fields only the user can answer, in input order. */
  needsUser: OpenQuestion[];
}

const NO_MATCH = "No profile field or approved Q&A answer matched this question.";
const LLM_DECLINED =
  "No profile field or approved Q&A answer matched, and the assistant declined to draft one.";
const LLM_UNSURE =
  "No profile field or approved Q&A answer matched, and the assistant was not confident enough to answer.";
const LLM_ERROR =
  "No profile field or approved Q&A answer matched, and the assistant failed with an error.";
const NO_RESUME = "The profile has no resume files to attach.";

/** Kinds whose value is free text typed into the element. */
const TEXTUAL: ReadonlySet<FieldKind> = new Set([
  "text",
  "email",
  "tel",
  "textarea",
  "combobox",
  "unknown",
]);

const YES_OPT_RE = /^\s*yes\b/i;
const NO_OPT_RE = /^\s*no\b/i;
const SPONSOR_RE = /sponsor/;
// "…without sponsorship?" / "not require sponsorship?" flip the question's polarity.
const SPONSOR_INVERTED_RE =
  /\bwithout\b.{0,40}sponsor|\bnot\b (require|need|needing).{0,20}sponsor|\bno sponsorship\b/;
const WORK_AUTH_RE =
  /\b(authori[sz]ed|entitled|eligible|legally able|right)\b.{0,30}\bto work\b|\bwork(ing)? (rights|authori[sz]ation|eligibility|entitlements?)\b|\bvisa status\b/;
const EMAIL_LABEL_RE = /\be ?mail\b/; // cleanLabel turns "e-mail" into "e mail"
const PHONE_LABEL_RE = /\b(phone|mobile|cell)\b/;
const LOCATION_RE = /\blocation\b|\bcity\b|\bsuburb\b|where (are you|do you) (based|live|located)/;
const NOTICE_RE =
  /\bnotice period\b|\bperiod of notice\b|\bnotice required\b|when (can|could) you start|how (much|long).{0,15}notice/;
const SALARY_RE =
  /\bsalary\b|\bcompensation\b|\bremuneration\b|\bpay expectations?\b|\bexpected pay\b|\bdesired pay\b/;

/** Threshold from ARCHITECTURE: token overlap >= 0.6 counts as a QA-bank hit. */
const QA_MATCH_THRESHOLD = 0.6;

function cleanLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function nonEmpty(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

// The single option matching `text` (exact first, then unique bidirectional
// substring), so "Permanent resident" is found inside "Australian permanent
// resident" — or null when zero or several candidates fit.
function matchOption(options: readonly string[], text: string): string | null {
  const t = text.trim().toLowerCase();
  if (t === "") return null;
  const exact = options.find((o) => o.trim().toLowerCase() === t);
  if (exact !== undefined) return exact;
  const partial = options.filter((o) => {
    const c = o.trim().toLowerCase();
    return c !== "" && (c.includes(t) || t.includes(c));
  });
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

// Free-text fields take the profile text verbatim; option fields require a
// unique option match (else no direct answer).
function withOptions(field: FormField, raw: string): string | null {
  const text = nonEmpty(raw);
  if (text === null) return null;
  if (field.options !== undefined && field.options.length > 0) {
    return matchOption(field.options, text);
  }
  return text;
}

// Prefer the form's own option text ("No, I will not require sponsorship")
// over a bare "Yes"/"No" literal.
function yesNoOption(field: FormField, yes: boolean): string {
  const re = yes ? YES_OPT_RE : NO_OPT_RE;
  const fromOptions = field.options?.find((o) => re.test(o));
  return fromOptions ?? (yes ? "Yes" : "No");
}

function isYesNoShaped(field: FormField): boolean {
  if (field.kind === "yesno") return true;
  const options = field.options ?? [];
  return options.some((o) => YES_OPT_RE.test(o)) && options.some((o) => NO_OPT_RE.test(o));
}

function resolveSponsorship(field: FormField, clean: string, profile: Profile): string | boolean | null {
  if (!SPONSOR_RE.test(clean)) return null;
  const yes = SPONSOR_INVERTED_RE.test(clean) ? !profile.needsSponsorship : profile.needsSponsorship;
  if (field.kind === "checkbox") return yes;
  if (TEXTUAL.has(field.kind) || isYesNoShaped(field)) return yesNoOption(field, yes);
  return null; // choice field without yes/no options — leave for QA/LLM/user
}

function resolveRights(field: FormField, clean: string, profile: Profile): string | boolean | null {
  if (!WORK_AUTH_RE.test(clean)) return null;
  if (field.kind === "checkbox") {
    // "I have the right to work…" — only safe to tick when no sponsorship is needed.
    return profile.needsSponsorship ? null : true;
  }
  if (isYesNoShaped(field)) {
    // "Authorized to work?" — a sponsorship-free profile answers yes. Anything
    // else is nuanced (temporary visas…) and falls through to QA/LLM/user.
    return profile.needsSponsorship ? null : yesNoOption(field, true);
  }
  if (field.options !== undefined && field.options.length > 0) {
    return matchOption(field.options, profile.workRights);
  }
  return nonEmpty(profile.workRights);
}

function resolveName(clean: string, profile: Profile): string | null {
  const name = profile.name.trim();
  if (name === "") return null;
  const parts = name.split(/\s+/);
  const first = parts[0] ?? name;
  if (/\b(first|given) ?name\b/.test(clean)) return first;
  if (/\b(last|family) ?name\b|\bsurname\b/.test(clean)) {
    return parts.length > 1 ? parts.slice(1).join(" ") : name;
  }
  if (/\bfull ?name\b|^(your |candidate )?name$/.test(clean)) return name;
  return null;
}

const LINK_RULES: readonly { label: RegExp; link: RegExp }[] = [
  { label: /\blinked ?in\b/, link: /linkedin/i },
  { label: /\bgit ?hub\b/, link: /github/i },
  { label: /\bportfolio\b|\bpersonal (website|site|page)\b|\bwebsite\b|\bblog\b/, link: /portfolio|website|blog|personal/i },
];

function resolveLink(clean: string, profile: Profile): string | null {
  for (const rule of LINK_RULES) {
    if (!rule.label.test(clean)) continue;
    const hit = profile.links.find((l) => rule.link.test(l.label) || rule.link.test(l.url));
    if (hit !== undefined) return hit.url;
  }
  return null;
}

// Direct profile mapping. Returns null when no rule confidently claims the
// field (empty profile values never count as answers).
function directAnswer(field: FormField, profile: Profile): string | boolean | null {
  if (field.kind === "date") return null; // the profile stores no raw dates
  const clean = cleanLabel(field.label);

  const sponsorship = resolveSponsorship(field, clean, profile);
  if (sponsorship !== null) return sponsorship;
  const rights = resolveRights(field, clean, profile);
  if (rights !== null) return rights;

  if (TEXTUAL.has(field.kind)) {
    if (field.kind === "email" || EMAIL_LABEL_RE.test(clean)) return nonEmpty(profile.email);
    if (field.kind === "tel" || PHONE_LABEL_RE.test(clean)) return nonEmpty(profile.phone);
    const name = resolveName(clean, profile);
    if (name !== null) return name;
    const link = resolveLink(clean, profile);
    if (link !== null) return link;
  }

  if (field.kind !== "checkbox") {
    if (LOCATION_RE.test(clean)) return withOptions(field, profile.location);
    if (NOTICE_RE.test(clean)) return withOptions(field, profile.noticePeriod);
    if (SALARY_RE.test(clean)) return withOptions(field, profile.salary ?? "");
  }
  return null;
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((t) => t !== ""));
}

// Overlap coefficient |A∩B| / min(|A|,|B|): a short canonical bank question
// still scores highly against a wordier form question that contains it.
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** Checkbox values are booleans in a FillPlan; map yes/no-ish strings across. */
function coerceForKind(field: FormField, value: string): string | boolean {
  if (field.kind === "checkbox") {
    if (/^\s*(yes|true|y)\s*$/i.test(value)) return true;
    if (/^\s*(no|false|n)\s*$/i.test(value)) return false;
  }
  return value;
}

function qaAnswer(field: FormField, profile: Profile): string | boolean | null {
  const label = tokenSet(normalizeQuestion(field.label));
  const withHint =
    field.hint !== undefined && field.hint !== ""
      ? tokenSet(normalizeQuestion(`${field.label} ${field.hint}`))
      : null;
  if (label.size === 0 && (withHint === null || withHint.size === 0)) return null;

  let best: { entry: QAEntry; score: number } | null = null;
  for (const entry of profile.qaBank) {
    // AnswerSource "qa_bank" is documented as "reusable approved answer".
    if (!entry.approved) continue;
    const q = tokenSet(normalizeQuestion(entry.question));
    const score = Math.max(tokenOverlap(label, q), withHint !== null ? tokenOverlap(withHint, q) : 0);
    if (score < QA_MATCH_THRESHOLD) continue;
    if (
      best === null ||
      score > best.score ||
      (score === best.score && entry.uses > best.entry.uses)
    ) {
      best = { entry, score };
    }
  }
  if (best === null) return null;
  if (field.options !== undefined && field.options.length > 0) {
    // The saved answer must land on one of the offered choices.
    return matchOption(field.options, best.entry.answer);
  }
  return coerceForKind(field, best.entry.answer);
}

// Spec: resume whose tag appears in the field's label/hint, else the first.
function pickResume(field: FormField, resumes: readonly ResumeRef[]): ResumeRef | null {
  const first = resumes[0];
  if (first === undefined) return null;
  const haystack = `${field.label} ${field.hint ?? ""}`.toLowerCase();
  const tagged = resumes.find(
    (r) => r.tag !== undefined && r.tag !== "" && haystack.includes(r.tag.toLowerCase()),
  );
  return tagged ?? first;
}

function openQuestion(field: FormField, reason: string): OpenQuestion {
  const q: OpenQuestion = { fieldId: field.id, label: field.label, reason };
  if (field.options !== undefined) q.options = field.options;
  return q;
}

/**
 * Resolve every form field to an answer or an open question for the user.
 * Order: direct profile mapping → approved Q&A bank (token overlap >= 0.6) →
 * `llm` delegate (kept only when confident; errors queue the field) → needsUser.
 * File fields attach the resume whose `tag` appears in the label/hint, else
 * the first stored resume; sponsorship yes/no derives from `needsSponsorship`
 * (false => "No", with "without sponsorship" phrasings inverted).
 */
export async function resolveAnswers(
  fields: FormField[],
  profile: Profile,
  llm?: AnswerDelegate,
): Promise<ResolutionResult> {
  const answers: ResolvedAnswer[] = [];
  const needsUser: OpenQuestion[] = [];

  for (const field of fields) {
    if (field.kind === "file") {
      const resume = pickResume(field, profile.resumes);
      if (resume === null) needsUser.push(openQuestion(field, NO_RESUME));
      else answers.push({ fieldId: field.id, value: resume.filename, source: "profile", resume });
      continue;
    }

    const direct = directAnswer(field, profile);
    if (direct !== null) {
      answers.push({ fieldId: field.id, value: direct, source: "profile" });
      continue;
    }

    const saved = qaAnswer(field, profile);
    if (saved !== null) {
      answers.push({ fieldId: field.id, value: saved, source: "qa_bank" });
      continue;
    }

    if (llm === undefined) {
      needsUser.push(openQuestion(field, NO_MATCH));
      continue;
    }
    try {
      const draft = await llm(field, profile);
      if (draft !== null && draft.confident) {
        answers.push({ fieldId: field.id, value: coerceForKind(field, draft.value), source: "llm" });
      } else {
        needsUser.push(openQuestion(field, draft === null ? LLM_DECLINED : LLM_UNSURE));
      }
    } catch {
      needsUser.push(openQuestion(field, LLM_ERROR));
    }
  }

  return { answers, needsUser };
}
