/**
 * Generic fallback adapter — heuristic discovery for application forms on
 * sites LarpMaxer has no branded adapter for.
 *
 * The registry keeps this adapter LAST. `matchesUrl` accepts every URL and
 * `detect` is the real gate.
 *
 * That gate demands POSITIVE evidence of an application form — a resume upload,
 * an email field, an apply-ish submit — scored on one container. "Some labelled
 * inputs and a button" is not enough: every job-board search page clears that
 * bar, and offering a user their own search filters as questions to answer is
 * worse than admitting the page is not fillable.
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
/** Visible label for a control, falling back to its placeholder. */
export function resolveLabel(el: Element): string {
  return labelFor(el) || (el.getAttribute("placeholder") ?? "").trim();
}

/**
 * A selector that will still resolve at fill time, stamping a marker
 * attribute when the element offers nothing stable.
 */
export function selectorFor(el: Element, doc: Document): string {
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
export function groupLabel(first: Element): string {
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
export function choiceLabel(input: Element): string {
  const parent = input.parentElement;
  if (parent && parent.tagName === "LABEL") return parseLabel(parent.textContent ?? "").label;
  return parseLabel(labelFor(input)).label;
}

/** Page furniture: whatever lives here is site chrome, never an application question. */
const CHROME_SELECTOR =
  'nav, header, footer, aside, [role="search"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]';

/** A control that is part of the site's own search/filter UI, not a question. */
/** True when the control belongs to the site's own nav/search furniture. */
export function isSiteChrome(el: Element): boolean {
  if ((el.getAttribute("type") ?? "").toLowerCase() === "search") return true;
  return el.closest(CHROME_SELECTOR) !== null;
}

/** Answerable controls inside `root`, ignoring site chrome and unlabelled inputs. */
function answerableInputs(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll("input, textarea, select")).filter((el) => {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (el.tagName === "INPUT" && SKIP_INPUT_TYPES.has(type)) return false;
    if (isSiteChrome(el)) return false;
    return visible(el) && resolveLabel(el).length > 0;
  });
}

/** Text a user would read on a button-ish control. */
function controlText(el: Element): string {
  return el.tagName === "INPUT" ? (el.getAttribute("value") ?? "") : (el.textContent ?? "");
}

/**
 * How strongly `root` looks like a job-application form.
 *
 * Weights reflect how specific each signal is: a file input on a form is
 * almost always a resume; "Submit" appears on every newsletter box. Search
 * regions score negative so a listing page cannot win on input count alone.
 */
function applicationScore(root: Element): number {
  let score = 0;
  if (root.querySelector('input[type="file"]')) score += 3;
  if (root.querySelector('input[type="email"], input[autocomplete="email"]')) score += 2;

  const controls = Array.from(
    root.querySelectorAll('button, input[type="submit"], input[type="button"]'),
  ).filter((el) => !isSiteChrome(el));
  if (controls.some((el) => /\b(apply|submit|send)\b/i.test(controlText(el)))) score += 2;

  const answerable = answerableInputs(root).length;
  if (answerable >= 3) score += 1;
  if (answerable >= 6) score += 1;

  // A search/filter region inside the candidate means we are probably looking
  // at a listing page that happens to contain a form.
  if (root.querySelector('[role="search"]')) score -= 2;
  return score;
}

/** Minimum score to claim a page. Tuned so a resume upload plus one more signal passes. */
const APPLICATION_THRESHOLD = 4;

/**
 * The element containing the application form, or null when the page has none.
 * Real `<form>` elements are preferred; `document.body` is the last resort for
 * the many ATS pages that never wrap their fields in a form tag.
 */
export function findApplicationForm(doc: Document): Element | null {
  const candidates: Element[] = Array.from(doc.querySelectorAll("form"));
  if (doc.body) candidates.push(doc.body);

  let best: Element | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = applicationScore(candidate);
    // Prefer the tightest container: a real <form> beats body at equal score.
    if (score > bestScore || (score === bestScore && best === doc.body && candidate !== doc.body)) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= APPLICATION_THRESHOLD ? best : null;
}

/** Fallback adapter instance; must stay last in the registry's `allAdapters`. */
export const generic: Adapter = {
  id: "generic",
  name: "Generic form",
  matchesUrl: () => true,
  detect(_url: string, doc: Document): boolean {
    return findApplicationForm(doc) !== null;
  },
  discover(doc: Document): FormField[] {
    const fields: FormField[] = [];
    const seenGroups = new Set<string>();
    // Scope to the application form: fields elsewhere on the page (site search,
    // newsletter signup, cookie banner) are not this application's questions.
    const root = findApplicationForm(doc);
    if (root === null) return fields;
    const elements = Array.from(root.querySelectorAll("input, textarea, select"));
    elements.forEach((el, index) => {
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (el.tagName === "INPUT" && SKIP_INPUT_TYPES.has(type)) return;
      if (!visible(el)) return;
      if (isSiteChrome(el)) return;

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
