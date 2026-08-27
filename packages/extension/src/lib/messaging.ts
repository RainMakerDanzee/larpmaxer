/**
 * Typed messaging helpers over chrome.runtime / chrome.tabs.
 *
 * Every payload on the wire is a core `Message`, except the extension-internal
 * ping/pong liveness probe below — deliberately outside the core union so the
 * core protocol stays free of extension plumbing.
 */

import type { Message } from "@larpmaxer/core";

/** Liveness probe the background sends to a tab's content script. */
export interface Ping {
  type: "LARPMAXER_PING";
}

/**
 * Content script's reply to a {@link Ping}: proves it is injected and reports
 * the login heuristic (a password field on the page) the background acts on.
 * The content script must answer via `sendResponse` — this is the one place
 * the request/response channel is used.
 */
export interface Pong {
  type: "LARPMAXER_PONG";
  hasPasswordField: boolean;
}

/** Send a core message to the content script in `tabId`; rejects if none is listening. */
export async function sendToTab(tabId: number, msg: Message): Promise<void> {
  await chrome.tabs.sendMessage(tabId, msg);
}

/**
 * Broadcast a core message to the other extension contexts (side panel or
 * background). Best-effort: resolves silently when nobody is listening,
 * e.g. the side panel is closed.
 */
export async function sendToRuntime(msg: Message): Promise<void> {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch (err) {
    // Broadcasts are fire-and-forget; a missing/silent receiver is expected.
    if (!/Receiving end does not exist|message port closed/i.test(String(err))) throw err;
  }
}

/**
 * Subscribe to core messages from this extension's own contexts.
 * Handlers are fire-and-forget: reply by sending a new message, never via
 * `sendResponse` (the ping/pong probe is handled separately by the content
 * script). Returns an unsubscribe function.
 */
export function onMessage(
  handler: (msg: Message, sender: chrome.runtime.MessageSender) => void,
): () => void {
  const listener = (raw: unknown, sender: chrome.runtime.MessageSender): void => {
    if (sender.id !== chrome.runtime.id) return; // not from this extension
    if (typeof raw !== "object" || raw === null) return;
    if (typeof (raw as { type?: unknown }).type !== "string") return;
    // Unknown `type` values simply fall through the handler's isMessage checks.
    handler(raw as Message, sender);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/**
 * Ping the content script in `tabId`. Resolves with its {@link Pong}, or
 * `undefined` when nothing answered (script not injected, or tab gone).
 */
export async function pingTab(tabId: number): Promise<Pong | undefined> {
  try {
    const res: unknown = await chrome.tabs.sendMessage(tabId, {
      type: "LARPMAXER_PING",
    } satisfies Ping);
    if (
      typeof res === "object" &&
      res !== null &&
      (res as { type?: unknown }).type === "LARPMAXER_PONG"
    ) {
      return res as Pong;
    }
  } catch {
    // No receiver in that tab — treat as "not injected".
  }
  return undefined;
}
