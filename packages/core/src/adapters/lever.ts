/**
 * Lever adapter — posting apply forms on jobs.lever.co (and jobs.eu.lever.co).
 *
 * Lever forms use stable `name` attributes rather than ids: system fields are
 * name/email/phone/resume/comments, and custom question inputs are named
 * `cards[<uuid>][fieldN]` (with hidden `cards[...][baseTemplate]` metadata
 * inputs that must be ignored).
 */
import type { Adapter, FieldKind, FormField } from "../types.js";
import { labelFor } from "../fill/dom.js";
import { SKIP_INPUT_TYPES, inferKind, inferRequired, parseLabel, selectOptions } from "./generic.js";

const HOSTS = /^jobs(\.eu)?\.lever\.co$/;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** One fixed-name Lever system field with its canonical label. */
function systemField(
  doc: Document,
  name: string,
  kind: FieldKind,
  label: string,
  tag: "input" | "textarea" = "input",
): FormField | null {
  const selector = `${tag}[name="${name}"]`;
  const el = doc.querySelector(selector);
  if (!el) return null;
  return { id: name, kind, label, selector, required: inferRequired(el) };
}

/** Custom question fields: visible controls named `cards[...]`. */
function cardFields(doc: Document): FormField[] {
  const out: FormField[] = [];
  for (const el of Array.from(doc.querySelectorAll('[name^="cards"]'))) {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") continue;
    // Lever posts card metadata (baseTemplate…) in hidden inputs — skip those,
    // along with credential and other never-fillable input types.
    if (tag === "INPUT" && SKIP_INPUT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase())) continue;
    const name = el.getAttribute("name") ?? "";
    const { label, required } = parseLabel(labelFor(el));
    const id = el.id || name;
    out.push({
      id,
      kind: inferKind(el),
      label: label || id,
      selector: el.id ? `#${el.id}` : `${tag.toLowerCase()}[name="${name}"]`,
      required: inferRequired(el) || required,
      ...(tag === "SELECT" ? { options: selectOptions(el) } : {}),
    });
  }
  return out;
}

/** Lever ATS adapter. */
export const lever: Adapter = {
  id: "lever",
  name: "Lever",
  matchesUrl(url: string): boolean {
    return HOSTS.test(hostOf(url));
  },
  detect(_url: string, doc: Document): boolean {
    if (doc.querySelector("form.application-form, form#application-form")) return true;
    return doc.querySelector('input[name="name"]') !== null && doc.querySelector('input[name="resume"]') !== null;
  },
  discover(doc: Document): FormField[] {
    const fields: FormField[] = [];
    const core = [
      systemField(doc, "name", "text", "Full name"),
      systemField(doc, "email", "email", "Email"),
      systemField(doc, "phone", "tel", "Phone"),
      systemField(doc, "resume", "file", "Resume/CV"),
      systemField(doc, "comments", "textarea", "Additional information", "textarea"),
    ];
    for (const field of core) if (field) fields.push(field);
    fields.push(...cardFields(doc));
    return fields;
  },
  submitSelector: 'button[type="submit"].postings-btn, #btn-submit',
  successMarkers: ["Application submitted", "Thank you"],
};
