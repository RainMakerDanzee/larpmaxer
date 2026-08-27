/**
 * Resume refinement, run where every other LLM call runs.
 *
 * The panel does the reading (bytes to text to a heuristic parse — all local,
 * no credential needed) and sends the parse here. The background owns the API
 * key and the provider, so this is the only place the resume text may be put
 * in front of a model.
 *
 * Refinement is strictly optional: with no provider configured, or on any
 * failure, the panel gets back exactly what it sent and the heuristic parse
 * stands.
 */

import { createProvider, refineResume, type Message } from "@larpmaxer/core";
import { sendToRuntime } from "../lib/messaging.js";
import { getSettings } from "./storage.js";

/** The parse shape carried by the protocol. */
type ParsedShape = Extract<Message, { type: "REFINE_RESUME_RESULT" }>["parsed"];

/** Refine a parse with the configured provider and broadcast the result. */
export async function handleRefineRequest(
  msg: Extract<Message, { type: "REFINE_RESUME_REQUEST" }>,
): Promise<void> {
  const { llm } = await getSettings();
  if (llm === undefined) {
    // Only reachable when the user chose "no model" in Settings; otherwise the
    // keyless on-device provider is the default.
    await reply(msg.parsed, false, "Answering without a model, as you asked — this is the rule-based read.");
    return;
  }

  try {
    // refineResume swallows provider errors itself; this guards the steps
    // around it, such as an unknown provider id in stored settings.
    const refined = await refineResume(msg.parsed, createProvider(llm));
    await reply(refined, true);
  } catch (err) {
    await reply(msg.parsed, false, describe(err));
  }
}

async function reply(parsed: ParsedShape, refined: boolean, note?: string): Promise<void> {
  await sendToRuntime({
    type: "REFINE_RESUME_RESULT",
    parsed,
    refined,
    ...(note === undefined ? {} : { note }),
  });
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message === "" ? "Refinement failed." : message;
}
