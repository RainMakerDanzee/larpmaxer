/**
 * Anthropic Messages API provider (non-streaming).
 */

import type { LlmConfig, LlmProvider } from "../types.js";
import { DEFAULT_MODELS, LlmError, httpError } from "./provider.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
// Anthropic requires max_tokens on every request; used when the caller passes none.
const DEFAULT_MAX_TOKENS = 1024;

interface AnthropicContentBlock {
  type?: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
}

/** Create an LlmProvider backed by the Anthropic Messages API. */
export function createAnthropicProvider(cfg: Pick<LlmConfig, "apiKey" | "model">): LlmProvider {
  const model = cfg.model || DEFAULT_MODELS.anthropic;
  return {
    id: "anthropic",
    async complete(messages, opts) {
      // Anthropic takes the system prompt as a top-level field, not a message.
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      const chat = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      const body: Record<string, unknown> = {
        model,
        max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: chat,
      };
      if (system.length > 0) body.system = system;

      const res = await post(cfg.apiKey, body);
      if (!res.ok) throw await httpError("anthropic", res);

      const data = (await res.json()) as AnthropicResponse;
      return (data.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
    },
  };
}

async function post(apiKey: string, body: Record<string, unknown>) {
  try {
    return await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        // Anthropic rejects CORS requests from browser contexts (our MV3
        // background worker) without this opt-in; it is a no-op in Node.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new LlmError("anthropic", `Network error calling Anthropic: ${reason}`);
  }
}
