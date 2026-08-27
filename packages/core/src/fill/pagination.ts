/**
 * Multi-step application forms: finding the control that advances a page.
 *
 * Plenty of ATSs split one application across several screens behind a Next
 * button — Workday, SmartRecruiters, SuccessFactors. `quirks.paginated` has
 * described that shape since the first commit with nothing reading it, so a
 * paginated form filled its first page and stopped.
 *
 * The delicate part is not clicking Next; it is being certain the control is
 * Next and not Submit. Clicking the wrong one sends a half-filled application,
 * which is the single worst thing this product can do — worse than filling
 * nothing. So the match is deliberately narrow: an explicit selector from the
 * adapter wins, and the text scan accepts only unambiguous forward words and
 * rejects anything that also reads like a submit.
 */

import { visible } from "./dom.js";

/** Words that mean "go to the next step". */
const NEXT_TEXT = /\b(next|continue|save\s+and\s+continue|proceed|forward)\b/i;

/**
 * Words that mean "send the application".
 *
 * Checked *after* the forward words and allowed to veto them, so a button
 * reading "Submit application" is never treated as Next even if some other
 * part of its label matches.
 */
const SUBMIT_TEXT = /\b(submit|apply|send|finish|complete)\b/i;

/** Words for going backwards, which must never be clicked. */
const BACK_TEXT = /\b(back|previous|prev|cancel|return)\b/i;

/** The visible text of a control, however it carries it. */
function controlText(el: Element): string {
  // tagName rather than instanceof, for the cross-realm reason in clickable.
  const own =
    el.tagName === "INPUT" ? ((el as HTMLInputElement).value ?? "") : (el.textContent ?? "");
  const label = el.getAttribute("aria-label") ?? "";
  const title = el.getAttribute("title") ?? "";
  return `${own} ${label} ${title}`.replace(/\s+/g, " ").trim();
}

/**
 * No `instanceof HTMLElement` here, deliberately. It is checked against this
 * realm's constructor, so it is false for an element from another document —
 * an iframed form in the wild, or a DOMParser fixture in a test. The query
 * that produced these elements already restricts them to controls, so
 * attributes are all this needs.
 */
function clickable(el: Element): boolean {
  if (el.hasAttribute("disabled")) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  return visible(el);
}

/**
 * Find the control that advances a paginated form to its next step.
 *
 * `selector`, when an adapter supplies one, is authoritative and is still
 * checked for being clickable. Otherwise every button-ish element is scanned
 * for an unambiguous forward label. Returns null when nothing qualifies —
 * which the caller must treat as "this is the last page", never as "click
 * something else".
 */
export function findNextControl(doc: Document, selector?: string): HTMLElement | null {
  if (selector !== undefined && selector !== "") {
    const explicit = doc.querySelector<HTMLElement>(selector);
    return explicit !== null && clickable(explicit) ? explicit : null;
  }

  const candidates = Array.from(
    doc.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'),
  );
  for (const el of candidates) {
    if (!clickable(el)) continue;
    const text = controlText(el);
    if (text === "") continue;
    // Order matters: a forward word only counts when nothing in the same
    // label reads like submitting or going back.
    if (!NEXT_TEXT.test(text)) continue;
    if (SUBMIT_TEXT.test(text) || BACK_TEXT.test(text)) continue;
    return el as HTMLElement;
  }
  return null;
}

/**
 * Has the form moved on?
 *
 * Multi-step forms rarely navigate; they swap the step in place, so "did the
 * page change" is answered by whether the fields on it changed rather than by
 * any load event. Comparing the set of field ids is enough and costs nothing.
 */
export function pageSignature(ids: string[]): string {
  return [...ids].sort().join("|");
}
