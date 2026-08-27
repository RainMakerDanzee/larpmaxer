/**
 * Field-discovery helpers: label resolution, visibility, selector lookup,
 * value read-back, and the ARIA combobox dance. Realm-safe by design —
 * tagName checks instead of cross-realm instanceof — and label/visibility
 * checks also work on fixture documents that have no window.
 */

import { clickOption, setNativeValue } from "./events.js";

/** Human label for a control, tried in order: `<label for>`, aria-label, aria-labelledby, wrapping `<label>`, nearest preceding heading; "" when none resolve. */
export function labelFor(el: Element): string {
  const doc = el.ownerDocument;

  if (el.id) {
    for (const label of Array.from(doc.querySelectorAll("label"))) {
      if (label.htmlFor === el.id) {
        const text = norm(label.textContent ?? "");
        if (text) return text;
      }
    }
  }

  const aria = norm(el.getAttribute("aria-label") ?? "");
  if (aria) return aria;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = norm(
      labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    if (text) return text;
  }

  const wrapping = el.closest("label");
  if (wrapping) {
    const text = norm(wrapping.textContent ?? "");
    if (text) return text;
  }

  // Last resort: the closest heading that appears before the control.
  for (const heading of Array.from(
    doc.querySelectorAll("h1,h2,h3,h4,h5,h6"),
  ).reverse()) {
    // 0x04 = DOCUMENT_POSITION_FOLLOWING: el comes after this heading.
    if ((heading.compareDocumentPosition(el) & 0x04) !== 0) {
      return norm(heading.textContent ?? "");
    }
  }

  return "";
}

/** True when the element would render: no [hidden] ancestor, no display:none / visibility:hidden, not `<input type="hidden">`; windowless fixture documents fall back to inline-style checks. */
export function visible(el: Element): boolean {
  if (el.closest("[hidden]")) return false;
  if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "hidden") {
    return false;
  }

  const check = (el as { checkVisibility?: (opts?: object) => boolean })
    .checkVisibility;
  if (typeof check === "function") {
    // Real browsers: the engine's own answer (covers ancestors, content-visibility…).
    // Both option spellings so old and new Chromium honour the visibility check.
    return check.call(el, { checkVisibilityCSS: true, visibilityProperty: true });
  }

  const win = el.ownerDocument.defaultView;
  for (let node: Element | null = el; node; node = node.parentElement) {
    // display does not inherit, so every ancestor must be checked; computed
    // visibility does inherit, so checking `el` alone suffices when a window
    // exists. Without one (DOMParser fixtures) only inline styles are visible
    // to us, so ancestors get the visibility check too.
    const style = win ? win.getComputedStyle(node) : (node as HTMLElement).style;
    if (!style) continue;
    if (style.display === "none") return false;
    if ((node === el || !win) && style.visibility === "hidden") return false;
  }
  return true;
}

/** Resolve `selector` to exactly one element, throwing a message that names the selector and the match count otherwise. */
export function findBySelector(doc: Document, selector: string): Element {
  let matches: NodeListOf<Element>;
  try {
    matches = doc.querySelectorAll(selector);
  } catch {
    throw new Error(`larpmaxer: invalid selector "${selector}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `larpmaxer: selector "${selector}" matched ${matches.length} elements, need exactly 1 — tighten the adapter's selector`,
    );
  }
  const only = matches.item(0);
  if (!only) {
    throw new Error(
      `larpmaxer: selector "${selector}" matched nothing — the form may have changed since discovery`,
    );
  }
  return only;
}

/** Current user-visible state of a control as a string: value for text fields, "true"/"false" for checks, selected option text for selects, filenames for file inputs. */
export function readBack(el: Element): string {
  const tag = el.tagName;

  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio") {
      return String(input.checked);
    }
    if (input.type === "file") {
      const files = input.files;
      if (!files) return "";
      const names: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const name = files[i]?.name;
        if (name) names.push(name);
      }
      return names.join(", ");
    }
    return input.value;
  }

  if (tag === "TEXTAREA") return (el as HTMLTextAreaElement).value;

  if (tag === "SELECT") {
    const select = el as HTMLSelectElement;
    return Array.from(select.selectedOptions)
      .map((opt) => norm(opt.textContent ?? "") || opt.value)
      .join(", ");
  }

  const ariaChecked = el.getAttribute("aria-checked");
  if (ariaChecked !== null) return ariaChecked;

  return norm(el.textContent ?? "");
}

/** Drive an ARIA combobox: focus, type `optionText` via the native setter, await a [role=listbox], then click the [role=option] whose text matches (exact first, else unique substring). */
export async function comboboxSelect(
  doc: Document,
  input: HTMLInputElement,
  optionText: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const pollMs = opts?.pollMs ?? 50;
  const want = norm(optionText).toLowerCase();
  if (!want) throw new Error("larpmaxer: comboboxSelect needs non-empty optionText");

  input.focus();
  setNativeValue(input, optionText);

  const seen = new Set<string>();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const options = Array.from(
      doc.querySelectorAll('[role="listbox"] [role="option"]'),
    );
    let exact: Element | undefined;
    const partial: { el: Element; text: string }[] = [];
    for (const opt of options) {
      const text = norm(opt.textContent ?? "");
      if (text) seen.add(text);
      const lower = text.toLowerCase();
      if (lower === want) {
        exact = opt;
        break;
      }
      if (lower.includes(want)) partial.push({ el: opt, text });
    }

    const sole = partial.length === 1 ? partial[0] : undefined;
    if (exact) {
      clickOption(exact);
      return;
    }
    if (sole) {
      clickOption(sole.el);
      return;
    }
    if (partial.length > 1) {
      const texts = partial.map((p) => `"${p.text}"`).join(", ");
      throw new Error(
        `larpmaxer: combobox text "${optionText}" is ambiguous — matches ${texts}`,
      );
    }
    if (Date.now() >= deadline) {
      const listed =
        seen.size > 0
          ? [...seen].map((t) => `"${t}"`).join(", ")
          : "none appeared";
      throw new Error(
        `larpmaxer: no combobox option matching "${optionText}" within ${timeoutMs}ms (options seen: ${listed})`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Collapse whitespace runs and trim. */
function norm(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
