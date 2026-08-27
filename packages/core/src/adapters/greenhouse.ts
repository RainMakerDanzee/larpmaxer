/**
 * Greenhouse adapter — hosted boards at boards.greenhouse.io and
 * job-boards.greenhouse.io (regional `.eu.` variants included).
 *
 * Embedded boards: company careers pages embed Greenhouse as
 * `<div id="grnhse_app"><iframe src="https://boards.greenhouse.io/embed/job_app?...">`.
 * The application form lives INSIDE that iframe, and the iframe document's URL
 * is a boards.greenhouse.io URL — so this adapter matches from the content
 * script running in the iframe; no host-page special-casing is needed.
 */
import type { Adapter, FieldKind, FormField } from "../types.js";
import { labelFor } from "../fill/dom.js";
import { SKIP_INPUT_TYPES, inferKind, inferRequired, parseLabel, selectOptions } from "./generic.js";

const HOSTS = /^(boards|job-boards)(\.eu)?\.greenhouse\.io$/;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** One fixed-id Greenhouse core field with its canonical label. */
function coreField(doc: Document, id: string, kind: FieldKind, label: string): FormField | null {
  const el = doc.querySelector(`#${id}`);
  if (!el) return null;
  return { id, kind, label, selector: `#${id}`, required: inferRequired(el) };
}

/** The resume upload: the file input whose id/name mentions "resume", else the first file input. */
function resumeField(doc: Document): FormField | null {
  const files = Array.from(doc.querySelectorAll('input[type="file"]'));
  const el = files.find((f) => /resume/i.test(`${f.id} ${f.getAttribute("name") ?? ""}`)) ?? files[0];
  if (!el) return null;
  return {
    id: el.id || "resume",
    kind: "file",
    label: "Resume/CV",
    selector: el.id ? `#${el.id}` : 'input[type="file"]',
    required: inferRequired(el),
  };
}

/** A multi-choice custom question; its options share an id prefix (question_123_0, question_123_1, …). */
function choiceGroup(doc: Document, group: string, type: string): FormField {
  const members = Array.from(doc.querySelectorAll(`input[id^="${group}_"]`)).filter(
    (m) => (m.getAttribute("type") ?? "").toLowerCase() === type,
  );
  let label = "";
  const container = members[0]?.closest("div, fieldset") ?? null;
  if (container) {
    for (const candidate of Array.from(container.querySelectorAll("label"))) {
      if (!candidate.querySelector("input")) {
        label = parseLabel(candidate.textContent ?? "").label;
        break;
      }
    }
  }
  const options = members
    .map((m) => {
      const parent = m.parentElement;
      return parent && parent.tagName === "LABEL" ? parseLabel(parent.textContent ?? "").label : "";
    })
    .filter((text) => text.length > 0);
  return {
    id: group,
    kind: type === "radio" ? "radio" : "checkbox",
    label: label || group,
    selector: `input[id^="${group}_"]`,
    required: members.some(inferRequired),
    options,
  };
}

/** Custom screening questions: inputs/textareas/selects with ids starting `question_`. */
function customFields(doc: Document): FormField[] {
  const out: FormField[] = [];
  const seenGroups = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll('[id^="question_"]'))) {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") continue;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    // Never surface hidden metadata or credential inputs as answerable fields.
    if (tag === "INPUT" && SKIP_INPUT_TYPES.has(type)) continue;
    if (type === "checkbox" || type === "radio") {
      const group = el.id.replace(/_\d+$/, "");
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);
      out.push(choiceGroup(doc, group, type));
      continue;
    }
    const { label, required } = parseLabel(labelFor(el));
    out.push({
      id: el.id,
      kind: inferKind(el),
      label: label || el.id,
      selector: `#${el.id}`,
      required: inferRequired(el) || required,
      ...(tag === "SELECT" ? { options: selectOptions(el) } : {}),
    });
  }
  return out;
}

/** Greenhouse ATS adapter. */
export const greenhouse: Adapter = {
  id: "greenhouse",
  name: "Greenhouse",
  matchesUrl(url: string): boolean {
    return HOSTS.test(hostOf(url));
  },
  detect(_url: string, doc: Document): boolean {
    return doc.querySelector("#first_name") !== null && doc.querySelector("#email") !== null;
  },
  discover(doc: Document): FormField[] {
    const fields: FormField[] = [];
    const core = [
      coreField(doc, "first_name", "text", "First Name"),
      coreField(doc, "last_name", "text", "Last Name"),
      coreField(doc, "email", "email", "Email"),
      coreField(doc, "phone", "tel", "Phone"),
      resumeField(doc),
    ];
    for (const field of core) if (field) fields.push(field);
    fields.push(...customFields(doc));
    return fields;
  },
  submitSelector: '#submit_app, button[type="submit"]',
  successMarkers: ["Thank you for applying", "application has been received"],
};
