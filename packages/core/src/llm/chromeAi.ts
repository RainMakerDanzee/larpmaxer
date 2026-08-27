/**
 * Chrome's built-in AI (Gemini Nano) as an LLM provider.
 *
 * This is the zero-setup brain: the model ships with the browser, runs on the
 * user's own machine, costs nothing, needs no API key and no account, and the
 * text never leaves the device. It is the default whenever the browser can
 * run it — which, as of 2026, is roughly half of desktop Chrome installs
 * (the rest fail a VRAM/RAM/disk bar, have it disabled by enterprise policy,
 * or are on mobile, where it does not exist at all).
 *
 * Two properties matter for how we use it:
 *
 *   - It supports schema-constrained output, enforced at sampling time. That
 *     makes "choose exactly one of these options" mechanically reliable, which
 *     is most of what an application form actually asks.
 *   - It is meaningfully slower and weaker than a frontier model on long free
 *     text. So the answer engine leans on it for classification and selection,
 *     and leaves prose to a cloud provider or to the user.
 *
 * The API is exposed to extensions as a `LanguageModel` global. It is accessed
 * defensively here: the surface is young, and a missing or older shape must
 * degrade to "unavailable" rather than throw.
 */

import type { LlmMessage, LlmProvider } from "../types.js";
import { LlmError } from "./provider.js";

/** How usable the on-device model is right now. */
export type ChromeAiAvailability =
  | "unavailable" // no API, unsupported hardware, or blocked by policy
  | "downloadable" // supported, but the weights still need fetching
  | "downloading" // fetch in progress
  | "available"; // ready to use immediately

/** Options accepted by `LanguageModel.create`, narrowed to what we pass. */
interface CreateOptions {
  initialPrompts?: { role: "system" | "user" | "assistant"; content: string }[];
  monitor?: (m: { addEventListener(type: "downloadprogress", fn: (e: ProgressLike) => void): void }) => void;
}

interface ProgressLike {
  loaded: number;
}

interface PromptOptions {
  /** JSON Schema the output is constrained to at sampling time. */
  responseConstraint?: object;
}

interface LanguageModelSession {
  prompt(input: string, options?: PromptOptions): Promise<string>;
  destroy?(): void;
}

interface LanguageModelApi {
  availability(): Promise<ChromeAiAvailability | string>;
  create(options?: CreateOptions): Promise<LanguageModelSession>;
}

/** Resolve the `LanguageModel` global without assuming it exists. */
function api(): LanguageModelApi | undefined {
  const g = globalThis as { LanguageModel?: LanguageModelApi };
  const candidate = g.LanguageModel;
  if (
    candidate !== undefined &&
    typeof candidate.availability === "function" &&
    typeof candidate.create === "function"
  ) {
    return candidate;
  }
  return undefined;
}

/**
 * Whether the on-device model can serve requests, and if not, why not.
 * Never throws: any failure to interrogate the API is reported as unavailable.
 */
export async function chromeAiAvailability(): Promise<ChromeAiAvailability> {
  const model = api();
  if (model === undefined) return "unavailable";
  try {
    const state = await model.availability();
    switch (state) {
      case "available":
      case "downloadable":
      case "downloading":
        return state;
      default:
        return "unavailable";
    }
  } catch {
    return "unavailable";
  }
}

/** True when the model is ready or can be made ready without user setup. */
export async function chromeAiUsable(): Promise<boolean> {
  const state = await chromeAiAvailability();
  return state !== "unavailable";
}

/**
 * Build a provider backed by the on-device model.
 *
 * `onDownloadProgress` is called with a 0–1 fraction while the weights are
 * fetched on first use, so the panel can say something honest instead of
 * appearing to hang for a few hundred megabytes.
 */
export function createChromeAiProvider(opts?: {
  onDownloadProgress?: (fraction: number) => void;
}): LlmProvider {
  return {
    id: "chrome",
    async complete(messages: LlmMessage[], options?: { maxTokens?: number }): Promise<string> {
      return promptOnDevice(messages, undefined, opts?.onDownloadProgress, options);
    },
  };
}

/**
 * Prompt the on-device model, optionally constraining the reply to a schema.
 *
 * Schema constraint is the reason this provider is worth having for form
 * filling: with `responseConstraint` the decoder cannot emit a value outside
 * the allowed set, so an option answer is valid by construction rather than by
 * hoping the model behaved.
 */
export async function promptOnDevice(
  messages: LlmMessage[],
  responseConstraint?: object,
  onDownloadProgress?: (fraction: number) => void,
  _options?: { maxTokens?: number },
): Promise<string> {
  const model = api();
  if (model === undefined) {
    throw new LlmError("chrome", "Chrome's built-in AI is not available in this browser.");
  }

  const state = await chromeAiAvailability();
  if (state === "unavailable") {
    throw new LlmError(
      "chrome",
      "Chrome's built-in AI is not available on this device — add an API key in Settings, or answer the question yourself.",
    );
  }

  // The API takes system context at session creation and the turn as one
  // prompt string, so fold our message list into that shape.
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turn = messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content)
    .join("\n\n");

  let session: LanguageModelSession | undefined;
  try {
    session = await model.create({
      ...(system !== "" ? { initialPrompts: [{ role: "system", content: system }] } : {}),
      ...(onDownloadProgress !== undefined
        ? {
            monitor: (m) => {
              m.addEventListener("downloadprogress", (e) => onDownloadProgress(e.loaded));
            },
          }
        : {}),
    });
    return await session.prompt(
      turn,
      responseConstraint !== undefined ? { responseConstraint } : undefined,
    );
  } catch (err) {
    throw new LlmError("chrome", `On-device model failed: ${errorText(err)}`);
  } finally {
    // Sessions hold model context; releasing keeps memory flat across a batch.
    session?.destroy?.();
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
