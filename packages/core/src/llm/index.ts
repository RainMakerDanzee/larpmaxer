/**
 * LLM barrel: provider factory + errors, per-provider constructors, the
 * evidence-pinned prompt builder, and the AnswerDelegate bridge.
 *
 * `AnswerDelegate` itself is deliberately NOT re-exported here — answers.ts
 * owns that contract (answerDelegate.ts imports it) and already exports it
 * through the package barrel.
 */

export * from "./provider.js";
export { createAnthropicProvider } from "./anthropic.js";
export { createOpenAiProvider } from "./openai.js";
export {
  createChromeAiProvider,
  chromeAiAvailability,
  chromeAiUsable,
  promptOnDevice,
  type ChromeAiAvailability,
} from "./chromeAi.js";
export * from "./prompts.js";
export { makeLlmDelegate, type DelegateAnswer } from "./answerDelegate.js";
