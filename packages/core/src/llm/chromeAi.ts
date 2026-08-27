/**
 * Chrome's built-in AI (Gemini Nano) as an LLM provider.
 *
 * This is the zero-setup brain: the model ships with the browser, runs on the
 * user's own machine, costs nothing, needs no API key and no account, and the
 * text never leaves the device. It is the default provider, and on a machine
 * that cannot run it every question simply falls through to the user — which
 * is the product's normal "ask, once" path, not a failure.
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
 * ## Why everything here has a timeout
 *
 * `LanguageModel.create()` does not reliably reject. When the weights are not
 * on disk it can sit forever with no progress events and no error, and the
 * availability it reported a moment earlier ("downloadable") turns out to mean
 * "maybe, eventually". A hang is far worse than a failure here: `answers.ts`
 * catches a throwing delegate and queues the field for the user, so an error
 * costs one question, while a hang stalls the entire run at the first LLM
 * field and never recovers. So every call into the API is raced against a
 * deadline and surfaces an actionable `LlmError`.
 *
 * ## Why downloading is opt-in
 *
 * Fetching the weights is a few hundred megabytes. That is a thing a user
 * chooses in Settings, on a click, watching a progress bar — never something
 * that happens implicitly behind a form fill. Calls made during a run refuse
 * fast and say what to do; only {@link downloadOnDeviceModel} may download.
 */

import type { LlmMessage, LlmProvider } from "../types.js";
import { LlmError } from "./provider.js";

/** How usable the on-device model is right now. */
export type ChromeAiAvailability =
  | "unavailable" // no API, unsupported hardware, or blocked by policy
  | "downloadable" // supported, but the weights still need fetching
  | "downloading" // fetch in progress
  | "available"; // ready to use immediately

/** Deadline for the availability probe, which the panel calls on open. */
const PROBE_TIMEOUT_MS = 5_000;
/** Deadline for opening a session when the weights are already on disk. */
const SESSION_TIMEOUT_MS = 20_000;
/** Deadline for one completion. Nano is slow, but not this slow. */
const PROMPT_TIMEOUT_MS = 90_000;
/** Deadline for the one-time weight download, which is genuinely large. */
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;

/** Options for a single on-device call. */
export interface OnDeviceOptions {
  /**
   * Permit this call to fetch the weights. Only the explicit download flow in
   * Settings sets this; a fill must never trigger a large download.
   */
  allowDownload?: boolean;
  /** Called with a 0-1 fraction while the weights download. */
  onDownloadProgress?: (fraction: number) => void;
  /** Override the deadline. Tests use this; product code should not. */
  timeoutMs?: number;
}

/** Options accepted by `LanguageModel.create`, narrowed to what we pass. */
interface CreateOptions {
  initialPrompts?: { role: "system" | "user" | "assistant"; content: string }[];
  monitor?: (m: {
    addEventListener(type: "downloadprogress", fn: (e: ProgressLike) => void): void;
  }) => void;
}

interface ProgressLike {
  loaded: number;
  /** Present on implementations that report bytes rather than a fraction. */
  total?: number;
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
 * Never throws: any failure to interrogate the API is reported as unavailable,
 * including one that hangs.
 */
export async function chromeAiAvailability(
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ChromeAiAvailability> {
  const model = api();
  if (model === undefined) return "unavailable";
  try {
    // Even the availability probe is raced: it is the first thing the panel
    // calls, and a stuck probe would hang the Settings tab on open.
    const state = await deadline(model.availability(), timeoutMs, "checking availability");
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

/** True only when the model can answer right now, with no download first. */
export async function chromeAiReady(): Promise<boolean> {
  return (await chromeAiAvailability()) === "available";
}

/**
 * Fetch the on-device weights, reporting progress as a 0-1 fraction.
 *
 * Call this from a user gesture in the panel — never from a run. Resolves with
 * the availability that resulted, so the caller can report honestly whether
 * the download actually produced a usable model.
 */
export async function downloadOnDeviceModel(
  onProgress?: (fraction: number) => void,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS,
): Promise<ChromeAiAvailability> {
  const model = api();
  if (model === undefined) return "unavailable";

  let session: LanguageModelSession | undefined;
  try {
    session = await deadline(
      model.create(monitorOptions(onProgress)),
      timeoutMs,
      "downloading the model",
    );
  } catch {
    // Fall through to report whatever state the browser is now in.
    return await chromeAiAvailability();
  } finally {
    session?.destroy?.();
  }
  return await chromeAiAvailability();
}

/**
 * Build a provider backed by the on-device model.
 *
 * The provider is for answering, so it never downloads: on a machine whose
 * weights are missing it fails fast and the question goes to the user.
 */
export function createChromeAiProvider(opts?: OnDeviceOptions): LlmProvider {
  return {
    id: "chrome",
    async complete(messages: LlmMessage[]): Promise<string> {
      return promptOnDevice(messages, undefined, opts);
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
  opts?: OnDeviceOptions,
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
  if (state !== "available" && opts?.allowDownload !== true) {
    // Refusing here is the whole point: this is the state that used to hang.
    throw new LlmError("chrome", downloadNeededMessage(state));
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

  const budget = opts?.timeoutMs;
  let session: LanguageModelSession | undefined;
  try {
    session = await deadline(
      model.create({
        ...(system !== "" ? { initialPrompts: [{ role: "system", content: system }] } : {}),
        ...monitorOptions(opts?.onDownloadProgress),
      }),
      budget ?? (opts?.allowDownload === true ? DOWNLOAD_TIMEOUT_MS : SESSION_TIMEOUT_MS),
      "starting the on-device model",
    );
    return await deadline(
      session.prompt(
        turn,
        responseConstraint !== undefined ? { responseConstraint } : undefined,
      ),
      budget ?? PROMPT_TIMEOUT_MS,
      "waiting for the on-device model",
    );
  } catch (err) {
    if (err instanceof LlmError) throw err;
    throw new LlmError("chrome", `On-device model failed: ${errorText(err)}`);
  } finally {
    // Sessions hold model context; releasing keeps memory flat across a batch.
    session?.destroy?.();
  }
}

function downloadNeededMessage(state: ChromeAiAvailability): string {
  return state === "downloading"
    ? "Chrome's built-in AI is still downloading — this question is yours for now; it will answer itself once Settings shows it ready."
    : "Chrome's built-in AI needs a one-time download before it can answer — open Settings and press Download, or add an API key.";
}

/** Wire a progress monitor only when someone is listening for it. */
function monitorOptions(onProgress?: (fraction: number) => void): CreateOptions {
  if (onProgress === undefined) return {};
  return {
    monitor: (m) => {
      m.addEventListener("downloadprogress", (e) => onProgress(fractionOf(e)));
    },
  };
}

/**
 * Normalise a progress event to 0-1.
 *
 * Chrome reports `loaded` as a fraction, but implementations have also
 * reported bytes alongside a `total`, so both are handled rather than
 * rendering a progress bar that reads "48000000%".
 */
function fractionOf(e: ProgressLike): number {
  const loaded = typeof e.loaded === "number" && Number.isFinite(e.loaded) ? e.loaded : 0;
  if (typeof e.total === "number" && e.total > 0) return clamp01(loaded / e.total);
  return clamp01(loaded);
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Race a promise against a deadline.
 *
 * `Promise.race` attaches handlers to the losing promise, so a late rejection
 * from the API is observed and never surfaces as an unhandled rejection.
 */
async function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new LlmError(
            "chrome",
            `Chrome's built-in AI stopped responding while ${what} (gave up after ${Math.round(ms / 1000)}s).`,
          ),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
