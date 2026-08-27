// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allAdapters, pickAdapter } from "../src/adapters/registry.js";
import { greenhouse } from "../src/adapters/greenhouse.js";
import { lever } from "../src/adapters/lever.js";
import { ashby } from "../src/adapters/ashby.js";
import { generic } from "../src/adapters/generic.js";
import type { FormField } from "../src/types.js";

const GH_URL = "https://boards.greenhouse.io/acme/jobs/4012345";
const LEVER_URL = "https://jobs.lever.co/acme/f1e2d3c4-b5a6";
const ASHBY_URL = "https://jobs.ashbyhq.com/acme/1a2b3c4d-application";

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function fixture(name: "greenhouse" | "lever" | "ashby"): Document {
  // vitest's jsdom environment rewrites import.meta.url to a root-relative
  // file URL, so try cwd-based paths (repo root via the root vitest.config.ts,
  // or packages/core when run from there) before URL resolution for plain node.
  const candidates = [
    join(process.cwd(), "packages", "core", "test", "fixtures", `${name}.html`),
    join(process.cwd(), "test", "fixtures", `${name}.html`),
  ];
  const path =
    candidates.find(existsSync) ??
    fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url));
  return docFrom(readFileSync(path, "utf8"));
}

/** Projection used for golden comparisons (drops nothing the answer engine needs). */
function shape(f: FormField): Record<string, unknown> {
  return { id: f.id, kind: f.kind, label: f.label, selector: f.selector, required: f.required, options: f.options, hint: f.hint };
}

const PLAIN_FORM = `
<main>
  <h1>Join Initech</h1>
  <form action="/apply" method="post">
    <label for="fn">Full name *</label>
    <input id="fn" type="text" required>
    <label for="em">Work email</label>
    <input id="em" type="email" aria-required="true">
    <label for="cl">Cover letter</label>
    <textarea id="cl" placeholder="Paste it here"></textarea>
    <label for="cv">Resume</label>
    <input id="cv" type="file">
    <label for="pw">Password</label>
    <input id="pw" type="password">
    <input type="hidden" name="csrf" value="x">
    <fieldset>
      <legend>Do you have working rights in Australia?</legend>
      <label><input type="radio" name="rights" value="yes"> Yes</label>
      <label><input type="radio" name="rights" value="no"> No</label>
    </fieldset>
    <label for="src">How did you hear about us?</label>
    <select id="src">
      <option value=""></option>
      <option>LinkedIn</option>
      <option>Other</option>
    </select>
    <button type="submit">Apply now</button>
  </form>
</main>`;

const NOT_A_FORM = `
<main>
  <h1>About us</h1>
  <p>We make things.</p>
  <label for="q">Search</label>
  <input id="q" type="search">
</main>`;

describe("greenhouse adapter", () => {
  it("matches hosted and embedded board URLs only", () => {
    expect(greenhouse.matchesUrl(GH_URL)).toBe(true);
    expect(greenhouse.matchesUrl("https://job-boards.greenhouse.io/acme/jobs/1")).toBe(true);
    expect(greenhouse.matchesUrl("https://boards.eu.greenhouse.io/acme/jobs/1")).toBe(true);
    expect(greenhouse.matchesUrl("https://boards.greenhouse.io/embed/job_app?for=acme&token=1")).toBe(true);
    expect(greenhouse.matchesUrl("https://example.com/careers")).toBe(false);
    expect(greenhouse.matchesUrl("not a url")).toBe(false);
  });

  it("detects its own form and rejects others", () => {
    expect(greenhouse.detect(GH_URL, fixture("greenhouse"))).toBe(true);
    expect(greenhouse.detect(GH_URL, fixture("lever"))).toBe(false);
  });

  it("discovers the golden field list", () => {
    const fields = greenhouse.discover(fixture("greenhouse"));
    expect(fields.map(shape)).toEqual([
      { id: "first_name", kind: "text", label: "First Name", selector: "#first_name", required: true },
      { id: "last_name", kind: "text", label: "Last Name", selector: "#last_name", required: true },
      { id: "email", kind: "email", label: "Email", selector: "#email", required: true },
      { id: "phone", kind: "tel", label: "Phone", selector: "#phone", required: false },
      { id: "resume", kind: "file", label: "Resume/CV", selector: "#resume", required: true },
      {
        id: "question_100",
        kind: "textarea",
        label: "Why do you want to work here?",
        selector: "#question_100",
        required: false,
      },
      {
        id: "question_101",
        kind: "select",
        label: "How did you hear about us?",
        selector: "#question_101",
        required: true,
        options: ["LinkedIn", "Referral"],
      },
      {
        id: "question_102",
        kind: "checkbox",
        label: "Which locations are you open to?",
        selector: 'input[id^="question_102_"]',
        required: false,
        options: ["Sydney", "Melbourne"],
      },
    ]);
  });

  it("never discovers hidden or password inputs as custom questions", () => {
    const doc = fixture("greenhouse");
    (doc.querySelector("form") ?? doc.body).insertAdjacentHTML(
      "beforeend",
      '<input id="question_998" type="hidden" value="token">' +
        '<label for="question_999">Password</label><input id="question_999" type="password">',
    );
    const ids = greenhouse.discover(doc).map((f) => f.id);
    expect(ids).not.toContain("question_998");
    expect(ids).not.toContain("question_999");
  });
});

describe("lever adapter", () => {
  it("matches jobs.lever.co URLs only", () => {
    expect(lever.matchesUrl(LEVER_URL)).toBe(true);
    expect(lever.matchesUrl("https://jobs.eu.lever.co/acme/f1e2")).toBe(true);
    expect(lever.matchesUrl(GH_URL)).toBe(false);
    expect(lever.matchesUrl("::::")).toBe(false);
  });

  it("detects its own form and rejects others", () => {
    expect(lever.detect(LEVER_URL, fixture("lever"))).toBe(true);
    expect(lever.detect(LEVER_URL, fixture("greenhouse"))).toBe(false);
  });

  it("discovers the golden field list (hidden card metadata excluded)", () => {
    const fields = lever.discover(fixture("lever"));
    expect(fields.map(shape)).toEqual([
      { id: "name", kind: "text", label: "Full name", selector: 'input[name="name"]', required: true },
      { id: "email", kind: "email", label: "Email", selector: 'input[name="email"]', required: true },
      { id: "phone", kind: "tel", label: "Phone", selector: 'input[name="phone"]', required: false },
      { id: "resume", kind: "file", label: "Resume/CV", selector: 'input[name="resume"]', required: true },
      {
        id: "comments",
        kind: "textarea",
        label: "Additional information",
        selector: 'textarea[name="comments"]',
        required: false,
      },
      { id: "card_q1", kind: "text", label: "Which timezone are you in?", selector: "#card_q1", required: true },
      {
        id: "cards[a1b2c3][field1]",
        kind: "select",
        label: "Preferred office",
        selector: 'select[name="cards[a1b2c3][field1]"]',
        required: false,
        options: ["Sydney", "Remote"],
      },
    ]);
  });

  it("never discovers a password card input", () => {
    const doc = fixture("lever");
    (doc.querySelector("form") ?? doc.body).insertAdjacentHTML(
      "beforeend",
      '<input name="cards[a1b2c3][field9]" type="password">',
    );
    const ids = lever.discover(doc).map((f) => f.id);
    expect(ids).not.toContain("cards[a1b2c3][field9]");
  });
});

describe("ashby adapter", () => {
  it("matches jobs.ashbyhq.com URLs only", () => {
    expect(ashby.matchesUrl(ASHBY_URL)).toBe(true);
    expect(ashby.matchesUrl(LEVER_URL)).toBe(false);
  });

  it("detects its own form and rejects others", () => {
    expect(ashby.detect(ASHBY_URL, fixture("ashby"))).toBe(true);
    expect(ashby.detect(ASHBY_URL, docFrom(PLAIN_FORM))).toBe(false);
  });

  it("discovers the golden field list", () => {
    const fields = ashby.discover(fixture("ashby"));
    expect(fields.map(shape)).toEqual([
      { id: "_systemfield_name", kind: "text", label: "Name", selector: "#_systemfield_name", required: true },
      { id: "_systemfield_email", kind: "email", label: "Email", selector: "#_systemfield_email", required: true },
      { id: "_systemfield_phone", kind: "tel", label: "Phone", selector: "#_systemfield_phone", required: false },
      {
        id: "_systemfield_location",
        kind: "combobox",
        label: "Location",
        selector: "#_systemfield_location",
        required: true,
      },
      { id: "_systemfield_resume", kind: "file", label: "Resume", selector: "#_systemfield_resume", required: true },
      {
        id: "q_workrights",
        kind: "yesno",
        label: "Do you have Australian work rights?",
        selector: "#q_workrights",
        required: false,
        options: ["Yes", "No"],
      },
    ]);
  });

  it("never mistakes the autofill widget for the resume field", () => {
    const doc = fixture("ashby");
    // The decoy autofill input is the first file input in the document…
    expect(doc.querySelector('input[type="file"]')?.id).toBe("autofill-file-input");
    // …but the discovered resume field targets #_systemfield_resume only.
    const files = ashby.discover(doc).filter((f) => f.kind === "file");
    expect(files.map((f) => f.selector)).toEqual(["#_systemfield_resume"]);
  });

  it("marks the text-identified submit button so submitSelector resolves it", () => {
    const doc = fixture("ashby");
    expect(doc.querySelector(ashby.submitSelector)).toBeNull(); // not marked yet
    ashby.discover(doc);
    expect(doc.querySelector(ashby.submitSelector)?.textContent?.trim()).toBe("Submit Application");
  });

  it("declares the React-form quirks", () => {
    expect(ashby.quirks).toEqual({ trustedKeyboardOnly: ["text", "email", "tel"], settleMs: 400 });
  });
});

describe("generic adapter", () => {
  it("claims only pages with a plausible application form", () => {
    expect(generic.matchesUrl("https://anything.example")).toBe(true);
    expect(generic.detect("https://careers.example.com/apply", docFrom(PLAIN_FORM))).toBe(true);
    expect(generic.detect("https://example.com/about", docFrom(NOT_A_FORM))).toBe(false);
  });

  it("discovers labelled fields with inferred kinds and requiredness", () => {
    const fields = generic.discover(docFrom(PLAIN_FORM));
    expect(fields.map(shape)).toEqual([
      { id: "fn", kind: "text", label: "Full name", selector: "#fn", required: true },
      { id: "em", kind: "email", label: "Work email", selector: "#em", required: true },
      { id: "cl", kind: "textarea", label: "Cover letter", selector: "#cl", required: false, hint: "Paste it here" },
      { id: "cv", kind: "file", label: "Resume", selector: "#cv", required: false },
      {
        id: "rights",
        kind: "radio",
        label: "Do you have working rights in Australia?",
        selector: 'input[name="rights"]',
        required: false,
        options: ["Yes", "No"],
      },
      {
        id: "src",
        kind: "select",
        label: "How did you hear about us?",
        selector: "#src",
        required: false,
        options: ["LinkedIn", "Other"],
      },
    ]);
  });
});

describe("registry", () => {
  it("orders branded adapters before the generic fallback", () => {
    expect(allAdapters.map((a) => a.id)).toEqual(["greenhouse", "lever", "ashby", "generic"]);
  });

  it("picks each branded adapter on its own URL + document", () => {
    expect(pickAdapter(GH_URL, fixture("greenhouse"))).toBe(greenhouse);
    expect(pickAdapter(LEVER_URL, fixture("lever"))).toBe(lever);
    expect(pickAdapter(ASHBY_URL, fixture("ashby"))).toBe(ashby);
  });

  it("falls back to generic for a plain application form on an unknown host", () => {
    expect(pickAdapter("https://careers.example.com/apply", docFrom(PLAIN_FORM))).toBe(generic);
  });

  it("falls back to generic when a known form is served from an unknown host", () => {
    // Branded adapters are gated on their URLs; the form is still fillable generically.
    expect(pickAdapter("https://careers.example.com/apply", fixture("greenhouse"))).toBe(generic);
  });

  it("returns null when the page has no plausible application form", () => {
    expect(pickAdapter("https://example.com/about", docFrom(NOT_A_FORM))).toBeNull();
  });
});
