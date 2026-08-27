/**
 * Framework-proof value setting. React/Vue track an input's `value` with a
 * descriptor installed on the element instance; writing through the native
 * prototype setter and then dispatching bubbling `input` + `change` makes the
 * framework accept the value exactly as if the user had typed it.
 *
 * Trust limit: script-dispatched events always have `isTrusted: false`, and
 * core cannot fake trust. Fields an adapter marks in
 * `AdapterQuirks.trustedKeyboardOnly` ignore untrusted input entirely — check
 * `needsTrustedKeyboard()` and route those fields through the extension's
 * real key dispatch (e.g. chrome.debugger `Input.dispatchKeyEvent`).
 */

import type { AdapterQuirks, FormField } from "../types.js";

/** Elements that carry a native `value` property setter. */
export type NativeValueElement =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement;

/** The element's own realm — event/File constructors must come from here, or foreign-realm documents (jsdom) reject them. */
export function windowOf(el: Element): Window & typeof globalThis {
  const win = el.ownerDocument.defaultView;
  if (!win) {
    throw new Error(
      "larpmaxer: element belongs to a document with no window — constructors unavailable",
    );
  }
  return win;
}

/** Dispatch bubbling `input` then `change` on `el`, mimicking a committed user edit. */
export function dispatchInputAndChange(el: Element): void {
  const win = windowOf(el);
  const InputEventCtor: new (type: string, init?: EventInit) => Event =
    win.InputEvent ?? win.Event;
  el.dispatchEvent(new InputEventCtor("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
}

/** Set `value` through the native prototype setter — bypassing framework instance trackers — then fire input+change. */
export function setNativeValue(el: NativeValueElement, value: string): void {
  nativeSetter(el, "value").call(el, value);
  dispatchInputAndChange(el);
}

/** Drive a checkbox (or radio) to `checked` via a synthetic click, which is what frameworks listen for; no-op when already there. */
export function setCheckbox(el: HTMLInputElement, checked: boolean): void {
  if (el.checked === checked) return;
  el.click(); // activation behaviour toggles .checked and fires input+change
  if (el.checked !== checked) {
    // A listener cancelled the click (controlled widget): force the property
    // and announce the edit so the framework re-reads it.
    nativeSetter(el, "checked").call(el, checked);
    dispatchInputAndChange(el);
  }
}

/** Click a custom widget option (or radio) the way a pointer would: pointer/mouse down-up then click, all bubbling and composed. */
export function clickOption(el: Element): void {
  const win = windowOf(el);
  // Older jsdom lacks PointerEvent; MouseEvent reaches the same listeners.
  const PointerCtor: typeof MouseEvent = win.PointerEvent ?? win.MouseEvent;
  // No `view`: nothing we target reads it, and jsdom rejects a WindowProxy there.
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    detail: 1,
  };
  el.dispatchEvent(new PointerCtor("pointerdown", init));
  el.dispatchEvent(new win.MouseEvent("mousedown", init));
  el.dispatchEvent(new PointerCtor("pointerup", init));
  el.dispatchEvent(new win.MouseEvent("mouseup", init));
  // An untrusted click still runs activation behaviour (checks radios etc.).
  el.dispatchEvent(new win.MouseEvent("click", init));
}

/** True when this field only registers trusted (real) keyboard events, which core cannot synthesize — the extension must type via real key dispatch instead. */
export function needsTrustedKeyboard(
  field: FormField,
  quirks?: AdapterQuirks,
): boolean {
  return quirks?.trustedKeyboardOnly?.includes(field.kind) ?? false;
}

/** Native setter for `prop`, looked up on the prototype chain so instance-level framework descriptors are skipped. */
function nativeSetter(
  el: object,
  prop: "value" | "checked",
): (this: unknown, v: unknown) => void {
  let proto: object | null = Object.getPrototypeOf(el) as object | null;
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (desc?.set) return desc.set as (this: unknown, v: unknown) => void;
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  const tag = (el as { tagName?: string }).tagName ?? "element";
  throw new Error(`larpmaxer: no native "${prop}" setter found on ${tag}`);
}
