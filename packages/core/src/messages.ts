/**
 * Runtime side of the message protocol. The `Message` union and the
 * compile-time narrower `isMessage` live in types.ts (the single source of
 * truth); this module adds only what the wire needs at runtime — a guard for
 * the untyped payloads chrome.runtime hands to listeners.
 */

import type { Message } from "./types.js";

// Record keyed by Message["type"] so GROWING the union without updating this
// map is a compile error (a plain Set<Message["type"]> only catches typos).
const MESSAGE_TYPE_MAP: Record<Message["type"], true> = {
  DETECT_REQUEST: true,
  DETECT_RESULT: true,
  DISCOVER_REQUEST: true,
  DISCOVER_RESULT: true,
  PLAN_READY: true,
  INTAKE_ANSWER: true,
  EXECUTE_PLAN: true,
  FILL_REPORT: true,
  APPROVE_SUBMIT: true,
  SUBMIT_RESULT: true,
  RUN_STATE: true,
  HUMAN_NEEDED: true,
  QUEUE_LINK: true,
  REGISTER_APPROVE: true,
  REGISTER_FILL: true,
  REGISTER_RESULT: true,
  QUEUE_REMOVE: true,
  QUEUE_STATE: true,
  REFINE_RESUME_REQUEST: true,
  REFINE_RESUME_RESULT: true,
};

const MESSAGE_TYPES: ReadonlySet<string> = new Set(Object.keys(MESSAGE_TYPE_MAP));

/** True when an unknown runtime payload is shaped like a protocol `Message` (object with a known `type`). */
export function isLarpMaxerMessage(value: unknown): value is Message {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    MESSAGE_TYPES.has((value as { type: string }).type)
  );
}
