/**
 * Bridges an LlmProvider into the pluggable LLM step that answers.ts calls
 * after direct profile mapping and the Q&A bank both miss.
 */

import type { LlmProvider } from "../types.js";
import type { AnswerDelegate } from "../answers.js";
import { UNKNOWN_ANSWER, buildAnswerMessages } from "./prompts.js";

/** An LLM-produced answer for one field. */
export interface DelegateAnswer {
  /** The answer text; for option fields, the option verbatim as the form offers it. */
  value: string;
  /** True only when the answer was validated against the field's options. */
  confident: boolean;
}

// The delegate CONTRACT (`AnswerDelegate`) is owned by answers.ts — imported
// here, never redefined, so the two modules cannot drift apart.
export type { AnswerDelegate } from "../answers.js";

// Answers are meant to be short; cap the completion so a rambling model
// cannot flood a form field.
const MAX_ANSWER_TOKENS = 400;

/**
 * Wrap a provider as an AnswerDelegate: UNKNOWN maps to null, and option-field
 * replies must match one of field.options (case-insensitive) or become null.
 */
export function makeLlmDelegate(provider: LlmProvider): AnswerDelegate {
  return async (field, profile) => {
    const raw = await provider.complete(buildAnswerMessages(field, profile), {
      maxTokens: MAX_ANSWER_TOKENS,
    });
    const text = raw.trim();
    if (text.length === 0) return null;

    const options = field.options ?? [];
    if (options.length > 0) {
      // Options are checked before the UNKNOWN sentinel so a literal
      // "Unknown" option remains selectable.
      const match = options.find((option) => option.trim().toLowerCase() === text.toLowerCase());
      if (match !== undefined) return { value: match, confident: true };
      // UNKNOWN, a hallucinated option, or a mangled one — never guess a choice.
      return null;
    }

    if (isUnknown(text)) return null;
    return { value: text, confident: false };
  };
}

// Tolerate minor decoration around the sentinel ("unknown", "UNKNOWN.").
function isUnknown(text: string): boolean {
  return text.replace(/[.!]+$/, "").trim().toUpperCase() === UNKNOWN_ANSWER;
}
