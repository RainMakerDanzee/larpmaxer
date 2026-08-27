/**
 * OpenAI Chat Completions API provider (non-streaming). Same contract as anthropic.ts.
 */

import type { LlmConfig, LlmProvider } from "../types.js";
import { DEFAULT_MODELS, LlmError, httpError } from "./provider.js";

const API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 1024;

interface OpenAiResponse {
  choices?: { message?: { content?: string | null } }[];
}

/** Create an LlmProvider backed by the OpenAI Chat Completions API. */
export function createOpenAiProvider(cfg: Pick<LlmConfig, "apiKey" | "model">): LlmProvider {
  const model = cfg.model || DEFAULT_MODELS.openai;
  return {
    id: "openai",
    async complete(messages, opts) {
      const body = {
        model,
        // Current OpenAI models reject the legacy max_tokens parameter.
        max_completion_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      };

      const res = await post(cfg.apiKey, body);
      if (!res.ok) throw await httpError("openai", res);

      const data = (await res.json()) as OpenAiResponse;
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}

async function post(apiKey: string, body: Record<string, unknown>) {
  try {
    return await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new LlmError("openai", `Network error calling OpenAI: ${reason}`);
  }
}
