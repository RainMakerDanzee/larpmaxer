/**
 * Ashby adapter — jobs.ashbyhq.com React application forms.
 *
 * Resume field warning: the FIRST `input[type="file"]` on an Ashby posting is
 * the "Autofill application from resume" widget, NOT the resume answer field.
 * The real resume upload is the input with id `_systemfield_resume`; discover
 * selects it by that id and never by file-input position.
 *
 * Submit control: Ashby's submit button is only identifiable by its visible
 * text ("Submit Application"), which CSS cannot target (there is no
 * `:contains`). `discover()` finds it by text and stamps
 * `data-larpmaxer-submit` on it, so `submitSelector` resolves via that marker
 * (with a plain `button[type="submit"]` fallback if discover has not run).
 *
 * Fill quirk: Ashby's controlled React inputs ignore programmatic value sets
 * for text-like kinds — hence `quirks.trustedKeyboardOnly` — and re-render
 * after input, hence `settleMs`.
 */
import type { Adapter, FieldKind, FormField } from "../types.js";
import { inferRequired } from "./generic.js";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** One fixed-id Ashby system field with its canonical label. */
function systemField(doc: Document, id: string, kind: FieldKind, label: string): FormField | null {
  const el = doc.querySelector(`#${id}`);
  if (!el) return null;
  return { id, kind, label, selector: `#${id}`, required: inferRequired(el) };
}

/** Phone number: Ashby renders it as the page's only `input[type="tel"]`. */
function phoneField(doc: Document): FormField | null {
  const el = doc.querySelector('input[type="tel"]');
  if (!el) return null;
  return {
    id: el.id || "phone",
    kind: "tel",
    label: "Phone",
    selector: el.id ? `#${el.id}` : 'input[type="tel"]',
    required: inferRequired(el),
  };
}

/** Location typeahead: the first `[role="combobox"]` on an Ashby posting. */
function locationField(doc: Document): FormField | null {
  const el = doc.querySelector('[role="combobox"]');
  if (!el) return null;
  return {
    id: el.id || "location",
    kind: "combobox",
    label: (el.getAttribute("aria-label") ?? "").trim() || "Location",
    selector: el.id ? `#${el.id}` : '[role="combobox"]',
    required: inferRequired(el),
  };
}

/**
 * Yes/No questions: pairs of sibling `<button aria-pressed>` elements whose
 * texts are exactly Yes and No. The aria-pressed attribute is required at
 * discovery time because it is how the executor verifies the selection after
 * clicking.
 */
function yesNoFields(doc: Document): FormField[] {
  const byParent = new Map<Element, Element[]>();
  for (const button of Array.from(doc.querySelectorAll("button[aria-pressed]"))) {
    const parent = button.parentElement;
    if (!parent) continue;
    byParent.set(parent, [...(byParent.get(parent) ?? []), button]);
  }
  const out: FormField[] = [];
  let counter = 0;
  for (const [parent, buttons] of byParent) {
    if (buttons.length !== 2) continue;
    const texts = buttons.map((b) => (b.textContent ?? "").trim());
    if (!(texts.includes("Yes") && texts.includes("No"))) continue;

    // Prefer an id-bearing ancestor that contains only this pair; otherwise
    // stamp a marker attribute (same strategy as the submit button).
    let id: string;
    let selector: string;
    const container = parent.closest("[id]");
    if (container && container.querySelectorAll("button[aria-pressed]").length === 2) {
      id = container.id;
      selector = `#${container.id}`;
    } else {
      id = `yesno_${counter}`;
      parent.setAttribute("data-larpmaxer-field", id);
      selector = `[data-larpmaxer-field="${id}"]`;
    }

    let label = "";
    const labelledBy = parent.getAttribute("aria-labelledby");
    if (labelledBy) label = (doc.getElementById(labelledBy)?.textContent ?? "").trim();
    if (!label && container) {
      const candidate = Array.from(container.querySelectorAll("label")).find((l) => !l.querySelector("input"));
      label = (candidate?.textContent ?? "").trim();
    }

    out.push({
      id,
      kind: "yesno",
      label: label || id,
      selector,
      required: inferRequired(parent),
      options: ["Yes", "No"],
    });
    counter += 1;
  }
  return out;
}

/** Text-match the submit button and stamp it so a plain CSS selector can find it. */
function markSubmitButton(doc: Document): void {
  const target = Array.from(doc.querySelectorAll("button")).find((b) =>
    /submit\s+application/i.test((b.textContent ?? "").trim()),
  );
  target?.setAttribute("data-larpmaxer-submit", "");
}

/** Ashby ATS adapter. */
export const ashby: Adapter = {
  id: "ashby",
  name: "Ashby",
  matchesUrl(url: string): boolean {
    return hostOf(url) === "jobs.ashbyhq.com";
  },
  detect(_url: string, doc: Document): boolean {
    return doc.querySelector('[id^="_systemfield_"]') !== null;
  },
  discover(doc: Document): FormField[] {
    markSubmitButton(doc);
    const fields: FormField[] = [];
    const core = [
      systemField(doc, "_systemfield_name", "text", "Name"),
      systemField(doc, "_systemfield_email", "email", "Email"),
      phoneField(doc),
      locationField(doc),
      // NEVER the first file input — that is the autofill widget (see file JSDoc).
      systemField(doc, "_systemfield_resume", "file", "Resume"),
    ];
    for (const field of core) if (field) fields.push(field);
    fields.push(...yesNoFields(doc));
    return fields;
  },
  submitSelector: '[data-larpmaxer-submit], button[type="submit"]',
  successMarkers: ["successfully submitted"],
  quirks: { trustedKeyboardOnly: ["text", "email", "tel"], settleMs: 400 },
};
