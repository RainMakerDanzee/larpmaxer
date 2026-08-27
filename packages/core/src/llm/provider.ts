/**
 * LLM provider factory plus the error contract shared by both providers.
 * LLM calls run only in the extension's background worker (see ARCHITECTURE.md).
 */

import type { LlmConfig, LlmProvider } from "../types.js";
// anthropic.ts / openai.ts import LlmError + httpError back from this module.
// The cycle is evaluation-safe (both sides use the bindings only at call time);
// if a no-cycle lint is ever added, move the error helpers to llm/errors.ts.
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAiProvider } from "./openai.js";
import { createChromeAiProvider } from "./chromeAi.js";

/** Model used when the user has not chosen one, per provider. */
export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.2",
  // The on-device model is whatever the browser ships; the field is inert.
  chrome: "gemini-nano",
} as const satisfies Record<LlmProvider["id"], string>;

/** Error raised by an LLM provider; `status` is set for HTTP failures. */
export class LlmError extends Error {
  /** Provider that raised the error. */
  readonly provider: LlmProvider["id"];
  /** HTTP status code when the API answered with a failure; unset for network errors. */
  readonly status?: number;

  constructor(provider: LlmProvider["id"], message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.provider = provider;
    if (status !== undefined) this.status = status;
  }
}

/** The slice of a fetch Response the error mapper needs (keeps DOM types out of signatures). */
export interface HttpFailure {
  /** HTTP status code of the failed response. */
  status: number;
  /** Reads the response body as text. */
  text(): Promise<string>;
}

/** Map a failed HTTP response to an LlmError with an actionable message. */
export async function httpError(provider: LlmProvider["id"], res: HttpFailure): Promise<LlmError> {
  const parts = [statusHint(res.status), await apiErrorMessage(res)].filter(
    (part): part is string => part !== undefined,
  );
  const message = parts.length > 0 ? parts.join(" — ") : `HTTP ${res.status}`;
  return new LlmError(provider, message, res.status);
}

/** Build the configured provider; an empty `model` falls back to DEFAULT_MODELS. */
export function createProvider(cfg: LlmConfig): LlmProvider {
  switch (cfg.provider) {
    case "anthropic":
      return createAnthropicProvider(cfg);
    case "openai":
      return createOpenAiProvider(cfg);
    case "chrome":
      return createChromeAiProvider();
    default: {
      // Exhaustive over LlmProvider["id"]; reachable only from untyped callers.
      const unknown: never = cfg.provider;
      throw new LlmError(cfg.provider, `Unknown LLM provider: ${String(unknown)}`);
    }
  }
}

function statusHint(status: number): string | undefined {
  // Note: the on-device provider never produces HTTP failures, so it never
  // reaches this mapper — its errors are constructed directly in chromeAi.ts.
  if (status === 401 || status === 403) return "Check your API key";
  if (status === 404) return "Model not found — check the model name in Settings";
  if (status === 429) return "Rate limited — try again in a moment";
  if (status >= 500) return "The provider had a server problem — try again shortly";
  return undefined;
}

/** Both APIs report failures as JSON { error: { message } }; tolerate anything else. */
async function apiErrorMessage(res: HttpFailure): Promise<string | undefined> {
  try {
    const body = JSON.parse(await res.text()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    return typeof message === "string" && message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}
