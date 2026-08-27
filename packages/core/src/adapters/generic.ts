/**
 * Generic fallback adapter — heuristic discovery for application forms on
 * sites LarpMaxer has no branded adapter for.
 *
 * The registry keeps this adapter LAST. `matchesUrl` accepts every URL and
 * `detect` is the real gate: it only claims pages that plausibly contain an
 * application form — a submit-ish control plus either a file input or at
 * least three labelled inputs.
 */
import type { Adapter, FieldKind, FormField } from "../types.js";
import { labelFor, visible } from "../fill/dom.js";

/** Input `type`s that are never fillable answers (passwords are humans-only); shared by every adapter's discover. */
export const SKIP_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "password",
]);

/** Infer a FieldKind from an element's tag name, `type` attribute and ARIA role. */
export function inferKind(el: Element): FieldKind {
  if (el.getAttribute("role") === "combobox") return "combobox";
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA") return "textarea";
  if (tag === "SELECT") return "select";
  if (tag !== "INPUT") return "unknown";
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  switch (type) {
    case "text":
    case "search":
    case "url":
    case "number":
      return "text";
    case "email":
      return "email";
    case "tel":
      return "tel";
    case "file":
      return "file";
    case "date":
      return "date";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    default:
      return "unknown";
  }
}

/** True when the element is marked required via the `required` attribute or `aria-required`. */
export function inferRequired(el: Element): boolean {
  return el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
}

/** Trim/collapse a raw label and strip a trailing required asterisk (`*` or `✱`), reporting whether one was present. */
export function parseLabel(raw: string): { label: string; required: boolean } {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  const required = /[*✱]\s*$/.test(collapsed);
  return { label: collapsed.replace(/\s*[*✱]+\s*$/, ""), required };
}

/** Non-empty option texts of a `<select>`; blank placeholder options are dropped. */
export function selectOptions(el: Element): string[] {
  return Array.from(el.querySelectorAll("option"))
    .map((option) => (option.textContent ?? "").trim())
    .filter((text) => text.length > 0);
}

// labelFor already falls back through aria-label/labelledby/wrapping label/
// preceding heading; the placeholder is the last resort beyond all of those.
function resolveLabel(el: Element): string {
  return labelFor(el) || (el.getAttribute("placeholder") ?? "").trim();
}

function selectorFor(el: Element, doc: Document): string {
  const id = el.id;
  if (id) return /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${id}"]`;
  const name = el.getAttribute("name");
  const tag = el.tagName.toLowerCase();
  if (name && !name.includes('"')) return `${tag}[name="${name}"]`;
  // Last resort: stamp a marker attribute so the selector survives re-query.
  const marker = `g${doc.querySelectorAll("[data-larpmaxer-field]").length}`;
  el.setAttribute("data-larpmaxer-field", marker);
  return `[data-larpmaxer-field="${marker}"]`;
}

/** Question text for a radio/checkbox group: fieldset legend, else the container's first option-free label. */
function groupLabel(first: Element): string {
  const legend = first.closest("fieldset")?.querySelector("legend");
  if (legend) return parseLabel(legend.textContent ?? "").label;
  const container = first.closest("div, fieldset, li, section");
  if (container) {
    for (const label of Array.from(container.querySelectorAll("label"))) {
      if (!label.querySelector("input, select, textarea")) {
        return parseLabel(label.textContent ?? "").label;
      }
    }
  }
  return "";
}

/** Visible text of one radio/checkbox choice (usually its wrapping label). */
function choiceLabel(input: Element): string {
  const parent = input.parentElement;
  if (parent && parent.tagName === "LABEL") return parseLabel(parent.textContent ?? "").label;
  return parseLabel(labelFor(input)).label;
}

function hasSubmitControl(doc: Document): boolean {
  if (doc.querySelector('button[type="submit"], input[type="submit"]')) return true;
  return Array.from(doc.querySelectorAll('button, input[type="button"]')).some((el) => {
    const text = el.tagName === "INPUT" ? (el.getAttribute("value") ?? "") : (el.textContent ?? "");
    return /\b(submit|apply|send)\b/i.test(text);
  });
}

function labelledInputCount(doc: Document): number {
  return Array.from(doc.querySelectorAll("input, textarea, select")).filter((el) => {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (el.tagName === "INPUT" && SKIP_INPUT_TYPES.has(type)) return false;
    return visible(el) && resolveLabel(el).length > 0;
  }).length;
}

/** Fallback adapter instance; must stay last in the registry's `allAdapters`. */
export const generic: Adapter = {
  id: "generic",
  name: "Generic form",
  matchesUrl: () => true,
  detect(_url: string, doc: Document): boolean {
    if (!hasSubmitControl(doc)) return false;
    if (doc.querySelector('input[type="file"]')) return true;
    return labelledInputCount(doc) >= 3;
  },
  discover(doc: Document): FormField[] {
    const fields: FormField[] = [];
    const seenGroups = new Set<string>();
    const elements = Array.from(doc.querySelectorAll("input, textarea, select"));
    elements.forEach((el, index) => {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (el.tagName === "INPUT" && SKIP_INPUT_TYPES.has(type)) return;
      if (!visible(el)) return;

      const name = el.getAttribute("name");
      if ((type === "radio" || type === "checkbox") && name && !name.includes('"')) {
        if (seenGroups.has(name)) return;
        const members = elements.filter(
          (m) => m.getAttribute("name") === name && (m.getAttribute("type") ?? "").toLowerCase() === type,
        );
        if (members.length > 1) {
          seenGroups.add(name);
          fields.push({
            id: name,
            kind: type === "radio" ? "radio" : "checkbox",
            label: groupLabel(el) || name,
            selector: `input[name="${name}"]`,
            required: members.some(inferRequired),
            options: members.map(choiceLabel).filter((text) => text.length > 0),
          });
          return;
        }
      }

      const raw = resolveLabel(el);
      if (!raw) return; // unlabelled controls cannot be answered truthfully
      const { label, required } = parseLabel(raw);
      const kind = inferKind(el);
      const placeholder = (el.getAttribute("placeholder") ?? "").trim();
      fields.push({
        id: el.id || name || `field_${index}`,
        kind,
        label,
        selector: selectorFor(el, doc),
        required: inferRequired(el) || required,
        ...(kind === "select" ? { options: selectOptions(el) } : {}),
        ...(placeholder && placeholder !== label ? { hint: placeholder } : {}),
      });
    });
    return fields;
  },
  submitSelector: 'button[type="submit"], input[type="submit"]',
  successMarkers: ["Thank you", "submitted", "received"],
};
