/**
 * A page, described so a model can read it — without the model ever touching
 * the page.
 *
 * Adapters are per-ATS knowledge: someone writes greenhouse.ts, and Greenhouse
 * works. That does not scale to "any site the user wants", and every site
 * nobody has written falls to a heuristic that must be conservative enough to
 * refuse a search page, which means it also refuses plenty of real forms.
 *
 * The alternative is to let a model decide. The danger in that is obvious: a
 * job posting is attacker-controlled text, and handing it to a model that then
 * tells us what to click is an instruction-injection channel straight into the
 * user's application.
 *
 * So the split here is deliberate and load-bearing:
 *
 *   - This file walks the DOM and produces a NUMBERED list of controls. Every
 *     selector, every element reference, every fact about the page comes from
 *     here, deterministically.
 *   - The model is shown that list and may answer only with indices into it
 *     (see classify.ts). It cannot emit a selector, a value, or a control that
 *     does not exist.
 *
 * The worst a hostile posting can achieve is a mislabelled field — which the
 * review card shows the user before anything is sent, which the answer engine
 * will only fill from profile facts anyway, and which cannot touch a password
 * or hidden input because the executor refuses those outright.
 */

import type { FieldKind } from "../types.js";
import { visible } from "../fill/dom.js";
import {
  SKIP_INPUT_TYPES,
  choiceLabel,
  groupLabel,
  inferKind,
  inferRequired,
  isSiteChrome,
  parseLabel,
  resolveLabel,
  selectOptions,
  selectorFor,
} from "../adapters/generic.js";

/** One fillable control, as offered to the model. */
export interface ControlCandidate {
  /** Position in the survey. The only handle the model may return. */
  index: number;
  kind: FieldKind;
  /** Label as read from the DOM — never from the model. */
  label: string;
  required: boolean;
  options?: string[];
  hint?: string;
  /** Nearest heading above the control, to help it group related fields. */
  section?: string;
  /**
   * Text immediately around an unlabelled control.
   *
   * The heuristics require a real label and give up without one, which is why
   * they cannot read a form that labels its inputs with plain divs — a very
   * common shape. A model can read that, so the text is offered when, and only
   * when, there is no label to use instead.
   */
  nearby?: string;
  /** Resolved at fill time. Deliberately never shown to the model. */
  selector: string;
}

/** A button the run might need to press. */
export interface ActionCandidate {
  index: number;
  /** Visible text, trimmed. */
  text: string;
  selector: string;
}

/** Everything a model needs to judge a page, and nothing it could act on. */
export interface PageSurvey {
  title: string;
  controls: ControlCandidate[];
  actions: ActionCandidate[];
  /** True when the page has a password box — a login, not an application. */
  hasPassword: boolean;
}

/** Cap the survey so a huge page cannot blow the model's context window. */
const MAX_CONTROLS = 60;
const MAX_ACTIONS = 25;

const ACTION_SELECTOR =
  'button, input[type="submit"], input[type="button"], [role="button"], a[href="#"]';

/**
 * Describe every fillable control and pressable action on the page.
 *
 * Unlike the generic adapter this does not first decide whether the page is an
 * application — that judgement is what the model is for. It does still drop
 * site chrome and hidden controls, because those are noise by construction and
 * spending context on them makes the real fields harder to see.
 */
export function surveyPage(doc: Document): PageSurvey {
  const controls: ControlCandidate[] = [];
  const seenGroups = new Set<string>();
  let hasPassword = false;

  for (const el of Array.from(doc.querySelectorAll("input, textarea, select"))) {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "password") {
      hasPassword = true;
      continue; // credentials are never the user's to automate
    }
    if (el.tagName === "INPUT" && SKIP_INPUT_TYPES.has(type)) continue;
    if (isSiteChrome(el)) continue;
    if (!visible(el)) continue;
    if (controls.length >= MAX_CONTROLS) break;

    const kind = inferKind(el);

    // Radios and checkboxes are one question with several inputs; survey the
    // question, not each button, or the model sees six fields where a user
    // sees one.
    if (kind === "radio" || kind === "checkbox") {
      const name = el.getAttribute("name") ?? "";
      const question = groupLabel(el) || parseLabel(resolveLabel(el)).label;
      const key = `${name}::${question}`;
      if (name !== "" && seenGroups.has(key)) continue;
      if (name !== "") seenGroups.add(key);

      const siblings =
        name === ""
          ? [el]
          : Array.from(doc.querySelectorAll(`input[name="${cssEscape(name)}"]`)).filter((s) =>
              visible(s),
            );
      const choices = siblings.map(choiceLabel).filter((c) => c !== "");
      const label = question || choices.join(" / ");
      if (label === "") continue;

      controls.push({
        index: controls.length,
        kind,
        label,
        required: inferRequired(el),
        ...(choices.length > 0 ? { options: choices } : {}),
        ...(sectionOf(el) !== "" ? { section: sectionOf(el) } : {}),
        selector: selectorFor(el, doc),
      });
      continue;
    }

    // parseLabel strips the required marker and reports it, so "Work email *"
    // becomes "Work email" plus required — the asterisk is punctuation, not
    // part of the question.
    const parsed = parseLabel(resolveLabel(el));
    const label = parsed.label;
    const options = selectOptions(el);
    // An unlabelled control is not automatically noise here — the model may
    // recognise it from its section or its neighbours — but a control with
    // neither label nor section is unreadable by anyone, so it is dropped.
    const section = sectionOf(el);
    // Always computed: a label is only demoted once the whole page is known,
    // and by then the element is out of reach.
    const nearby = nearbyText(el);
    // Unreadable by anyone: no label, no heading, no surrounding words.
    if (label === "" && section === "" && nearby === "") continue;

    const placeholder = (el.getAttribute("placeholder") ?? "").trim();
    controls.push({
      index: controls.length,
      kind,
      label,
      required: inferRequired(el) || parsed.required,
      ...(options.length > 0 ? { options } : {}),
      ...(placeholder !== "" && placeholder !== label ? { hint: placeholder } : {}),
      ...(section !== "" ? { section } : {}),
      ...(nearby !== "" ? { nearby } : {}),
      selector: selectorFor(el, doc),
    });
  }

  const actions: ActionCandidate[] = [];
  for (const el of Array.from(doc.querySelectorAll(ACTION_SELECTOR))) {
    if (actions.length >= MAX_ACTIONS) break;
    if (isSiteChrome(el)) continue;
    if (!visible(el)) continue;
    const text = actionText(el);
    if (text === "") continue;
    actions.push({ index: actions.length, text, selector: selectorFor(el, doc) });
  }

  return { title: (doc.title ?? "").trim(), controls: demoteSharedLabels(controls), actions, hasPassword };
}

/**
 * Drop a "label" that several controls share.
 *
 * Label resolution falls back to the nearest heading, so a form that captions
 * its inputs with plain divs gives every field the same string — five fields
 * all called "Submit your details", which names none of them. A label that
 * does not distinguish one control from another is worse than no label,
 * because it looks like an answer; the surrounding text is what a reader
 * actually uses, so that is what the model is shown instead.
 */
function demoteSharedLabels(controls: ControlCandidate[]): ControlCandidate[] {
  const counts = new Map<string, number>();
  for (const c of controls) {
    if (c.label !== "") counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  }
  return controls.map((c) => {
    if (c.label === "" || (counts.get(c.label) ?? 0) < 2) return c;
    const { label: shared, ...rest } = c;
    return { ...rest, label: "", section: shared };
  });
}

/** Visible text of a button, however it carries it. */
function actionText(el: Element): string {
  const own =
    el.tagName === "INPUT" ? ((el as HTMLInputElement).value ?? "") : (el.textContent ?? "");
  const aria = el.getAttribute("aria-label") ?? "";
  return `${own} ${aria}`.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * The words wrapping an unlabelled control.
 *
 * Walks out to the first ancestor carrying text of its own, and strips the
 * values of any other controls inside it so one field's text cannot be read
 * as another's label.
 */
function nearbyText(el: Element): string {
  for (let node = el.parentElement, hops = 0; node && hops < 4; node = node.parentElement, hops++) {
    const clone = node.cloneNode(true) as Element;
    for (const control of Array.from(clone.querySelectorAll("input, textarea, select, button"))) {
      control.remove();
    }
    const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length >= 2) return text.slice(0, 120);
  }
  return "";
}

/** The nearest heading above a control, which usually names its group. */
function sectionOf(el: Element): string {
  const container = el.closest("form, fieldset, section, div");
  for (let node: Element | null = container; node; node = node.parentElement) {
    const heading = node.querySelector("h1, h2, h3, h4, legend");
    if (heading) {
      const text = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text !== "") return text.slice(0, 80);
    }
  }
  return "";
}

/** Minimal escaping for a name used inside an attribute selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
