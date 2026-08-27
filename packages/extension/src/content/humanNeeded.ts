/**
 * Human-only blocker detection for the content script.
 *
 * LarpMaxer never enters credentials and never solves CAPTCHAs
 * (ARCHITECTURE.md, non-negotiable rule 2). These detectors let a run pause
 * with a HUMAN_NEEDED message — "your turn" — instead of failing noisily or,
 * worse, trying to push through.
 */

import type { Message } from "@larpmaxer/core";

/** Blocker reasons this module can detect ("unknown_page" is the background's call to make). */
export type HumanBlockerReason = Exclude<
  Extract<Message, { type: "HUMAN_NEEDED" }>["reason"],
  "unknown_page"
>;

/** A human-only blocker found on the page: why to pause, and what exactly was seen. */
export interface HumanBlocker {
  reason: HumanBlockerReason;
  detail: string;
}

// Widgets that mean "a human must prove they are human". Presence (not
// visibility) is the trigger: invisible reCAPTCHA still needs a human the
// moment it decides to challenge.
const CAPTCHA_SELECTORS: readonly string[] = [
  'iframe[src*="captcha"]', // covers reCAPTCHA and hCaptcha challenge frames
  ".g-recaptcha",
  ".h-captcha",
  "[data-hcaptcha-widget-id]",
];

// Hidden password inputs (e.g. an unopened header login form) should not
// pause a run, so require the element to take up layout space.
function isRenderable(el: Element): boolean {
  return el.getClientRects().length > 0;
}

/** True when the page shows a visible password input — i.e. a login wall. */
export function hasPasswordField(doc: Document): boolean {
  return Array.from(doc.querySelectorAll('input[type="password"]')).some(isRenderable);
}

/** The first human-only blocker on the page (login outranks captcha), or null when clear. */
export function detectHumanNeeded(doc: Document): HumanBlocker | null {
  if (hasPasswordField(doc)) {
    return { reason: "login", detail: "visible password input — a human must sign in" };
  }
  const match = CAPTCHA_SELECTORS.find((selector) => doc.querySelector(selector) !== null);
  if (match !== undefined) {
    return { reason: "captcha", detail: `captcha widget present (matched ${match})` };
  }
  return null;
}
