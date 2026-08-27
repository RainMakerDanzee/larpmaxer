/**
 * Prompt construction for the answer engine. The system prompt is the soul of
 * the product: the model may only restate profile facts, never invent them.
 */

import type { FormField, LlmMessage, Profile, ResumeRef } from "../types.js";

/** Exact reply the model must give when the profile lacks the needed fact. */
export const UNKNOWN_ANSWER = "UNKNOWN";

/** Build the messages that answer one form field using only profile facts. */
export function buildAnswerMessages(field: FormField, profile: Profile): LlmMessage[] {
  return [
    { role: "system", content: systemPrompt(profile) },
    { role: "user", content: fieldPrompt(field) },
  ];
}

function systemPrompt(profile: Profile): string {
  return [
    "You answer job-application form questions on behalf of the applicant described by the profile JSON below.",
    "",
    "Rules, in priority order:",
    "1. Use ONLY facts present in the profile JSON. Never invent, assume, or embellish employers, titles, dates, skills, credentials, or numbers.",
    `2. If the question needs a fact that is not in the profile, reply with exactly ${UNKNOWN_ANSWER} and nothing else.`,
    `3. When the question lists options, reply with exactly one of the listed options, copied verbatim. If the profile supports none of them, reply ${UNKNOWN_ANSWER}.`,
    "4. Be concise. Write in the first person as the applicant. Plain text only: no markdown, no quotation marks around the answer, no explanations. Reply with the answer alone.",
    "",
    "Profile JSON:",
    profileJson(profile),
  ].join("\n");
}

function fieldPrompt(field: FormField): string {
  const lines = [
    `Question: ${field.label}`,
    `Field type: ${field.kind} (${field.required ? "required" : "optional"})`,
  ];
  if (field.hint) lines.push(`Hint from the form: ${field.hint}`);
  const options = field.options ?? [];
  if (options.length > 0) {
    lines.push("Options (reply with one, verbatim):");
    for (const option of options) lines.push(`- ${option}`);
  }
  return lines.join("\n");
}

// Resume entries are rebuilt from their declared fields so stray runtime
// properties (e.g. file bytes attached by storage code) never reach the model.
function profileJson(profile: Profile): string {
  const resumes = profile.resumes.map(strippedRef);
  return JSON.stringify({ ...profile, resumes }, null, 2);
}

function strippedRef(ref: ResumeRef): ResumeRef {
  const clean: ResumeRef = { id: ref.id, filename: ref.filename, mime: ref.mime };
  if (ref.tag !== undefined) clean.tag = ref.tag;
  return clean;
}
