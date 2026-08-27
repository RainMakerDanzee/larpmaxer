# Writing an adapter

An adapter teaches LarpMaxer one applicant-tracking system. It is a single file in
`packages/core/src/adapters/`, pure over the `Document` it is handed (no globals, no network),
which is what lets it run against saved fixtures in Node and be reviewed as a golden field
list. Most adapters are 100–200 lines and take about 30 minutes plus a manual pass.

You are implementing the `Adapter` interface from
[`packages/core/src/types.ts`](../packages/core/src/types.ts) — read it first, it is short:

```ts
export interface Adapter {
  id: string;                              // stable id, e.g. "workable"
  name: string;                            // display name for the UI
  matchesUrl(url: string): boolean;        // fast, DOM-free pre-filter
  detect(url: string, doc: Document): boolean;   // deep check against the live document
  discover(doc: Document): FormField[];    // every fillable field on the form
  submitSelector: string;                  // the real submit control
  successMarkers: string[];                // text fragments proving submission succeeded
  quirks?: AdapterQuirks;                  // ATS-specific executor behaviour
}
```

The workflow is test-first: fixture → golden test → implement → register → manual pass. In that
order — the fixture is the contract, and CI runs against it forever.

## Step 1 — Save a fixture

1. Find a live posting on your target ATS and open its application form.
2. In the DevTools console: `copy(document.documentElement.outerHTML)`.
3. Paste into `packages/core/test/fixtures/<ats>.html` (e.g. `workable.html`).
4. **Scrub it.** No real personal data, ever: clear prefilled input values, replace CSRF/session
   tokens in hidden inputs with `FIXTURE`, drop cookie banners. You may delete third-party
   analytics scripts to shrink the file — the form and its labels must stay byte-faithful.
5. Keep it representative: the fixture should contain at least one required marker, one
   select or combobox, and the resume file input if the ATS has one.

If the ATS renders the form only after JavaScript runs, snapshot *after* it renders (that is
what the console trick does — `outerHTML` reflects the live DOM, not the source).

## Step 2 — Write the golden test first

Create `packages/core/test/<ats>.test.ts`. It fails until Step 3 is done; that is the point.

House style (see `test/adapters.test.ts`): the golden `discover()` expectation is a field list
you write out **explicitly** with `toEqual`, not a vitest snapshot file — the expected form is
in the diff, so reviewers read it line-by-line and nothing updates it by accident. One gotcha:
vitest's jsdom environment rewrites `import.meta.url`, so load fixtures by cwd-based candidate
paths (copy the `fixture()` helper from `adapters.test.ts`) rather than
`new URL(..., import.meta.url)` alone — the URL-only form fails under the repo's vitest config.

```ts
// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workable } from "../src/adapters/workable";

function fixture(name: string): Document {
  const candidates = [
    join(process.cwd(), "packages", "core", "test", "fixtures", `${name}.html`),
    join(process.cwd(), "test", "fixtures", `${name}.html`),
  ];
  const path =
    candidates.find(existsSync) ??
    fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url));
  return new DOMParser().parseFromString(readFileSync(path, "utf8"), "text/html");
}

describe("workable", () => {
  it("matches application URLs", () => {
    expect(workable.matchesUrl("https://apply.workable.com/acme/j/AB12CD34EF/")).toBe(true);
    expect(workable.matchesUrl("https://acme.com/careers")).toBe(false);
  });

  it("detects the form in the fixture", () => {
    expect(workable.detect("https://apply.workable.com/acme/j/AB12CD34EF/", fixture("workable"))).toBe(true);
  });

  it("discovers the golden field list", () => {
    expect(workable.discover(fixture("workable"))).toEqual([
      { id: "firstname", kind: "text", label: "First name", selector: "#firstname", required: true },
      // …every field on the fixture, written out by hand…
    ]);
  });
});
```

**Write the golden list by reading the fixture, not by pasting test output.** The list is the
review artifact: every visible field present with the label an applicant would see, kinds
correct, selectors stable, `required` right, selects carrying their `options`. If you wouldn't
sign your name to the list, the adapter isn't done. Change it later only deliberately: edit the
expected fields, plus a sentence in the PR about what changed and why.

## Step 3 — Implement the adapter

Create `packages/core/src/adapters/<ats>.ts`. Import types from `../types`; never redefine
them. A trimmed real-shape example:

```ts
import type { Adapter, FieldKind, FormField } from "../types";

/** Workable hosted application forms (apply.workable.com). */
export const workable: Adapter = {
  id: "workable",
  name: "Workable",

  matchesUrl(url) {
    return url.includes("apply.workable.com");
  },

  detect(url, doc) {
    return (
      url.includes("apply.workable.com") &&
      doc.querySelector("form[data-ui='application-form']") !== null
    );
  },

  discover(doc) {
    const form = doc.querySelector("form[data-ui='application-form']");
    if (!form) return [];

    const fields: FormField[] = [];
    const controls = form.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("input, textarea, select");

    for (const el of controls) {
      if (el.type === "hidden" || el.disabled) continue;

      const label = labelFor(el);
      if (!label) continue; // a control an applicant can't see or name is not a field

      fields.push({
        id: el.name || el.id,
        kind: kindOf(el),
        label,
        selector: el.id ? `#${el.id}` : `[name="${el.name}"]`,
        required: el.required || el.getAttribute("aria-required") === "true",
        options:
          el instanceof HTMLSelectElement
            ? [...el.options].map((o) => o.text).filter(Boolean)
            : undefined,
        hint: el.getAttribute("placeholder") ?? undefined,
      });
    }
    return fields;
  },

  submitSelector: "button[data-ui='submit-application']",
  successMarkers: ["Thank you", "Your application has been submitted"],
};
```

`labelFor` and `kindOf` are where the per-ATS knowledge lives. Before hand-rolling them, look
at core's `fill/dom.ts` — label resolution (`<label for>`, `aria-label`, `aria-labelledby`,
wrapping labels, nearest preceding heading), visibility checks, read-back, and the combobox
helper are shared there so adapters stay thin. `adapters/generic.ts` also exports the
heuristics the branded adapters reuse (`inferKind`, `inferRequired`, `parseLabel`,
`selectOptions`, `SKIP_INPUT_TYPES`) — the Greenhouse and Lever adapters are built on them.

Ground rules that reviews will hold you to:

- **`matchesUrl` is DOM-free and cheap** — it runs as a pre-filter on every navigation.
  `detect` is the deep check: URL *and* a structural marker in the document.
- **Selectors must survive a reload.** `FormField.selector` has to resolve to the same element
  at fill time, in a fresh document. Prefer stable ids and `name` attributes; never
  `:nth-child` chains. If the ATS generates random ids per page load, key off `name` or
  `data-*` attributes.
- **Kinds drive the executor.** Map honestly: `email`/`tel` when the input says so, `combobox`
  for typeaheads (location pickers, "how did you hear about us"), `file` for the resume input,
  `yesno` for a Yes/No radio pair. Collapse a radio group into one `FormField` whose `options`
  are the choice labels. Use `unknown` rather than guessing a specific widget — the executor
  treats `unknown` as plain text and the read-back verification grades the result, instead of
  driving the wrong control.
- **`required` matters.** `FillReport.complete` is computed from required fields; a wrong
  `required` either blocks a finishable run or lets an unfinished one look done.
- **`submitSelector` is the real submit**, not a Next button. `successMarkers` are literal text
  fragments from the confirmation state ("Thank you for applying") — the executor uses them to
  produce `SubmitResult.evidence`.

## Step 4 — Register it

Add your adapter to `allAdapters` in `packages/core/src/adapters/registry.ts`, **before**
`generic`. Order matters: the registry picks the first adapter whose `matchesUrl` and `detect`
both pass, and `generic` is the catch-all last resort.

## Quirks — and the war story behind them

`AdapterQuirks` exists because of a week we lost to Ashby. The short version teaches you most
of what you need to know about filling modern forms.

**Act 1 — the assignment that vanished.** The naive move is `el.value = "Riley"`. The text even
shows up. Then the form says "This field is required" on submit, or the value silently vanishes
on the next keystroke. Reason: React controlled inputs render from component state, and
component state never heard about your assignment. You didn't fill the form; you graffitied the
DOM and React painted over it.

**Act 2 — the value tracker.** The obvious fix — assign, then dispatch
`new Event("input", { bubbles: true })` — *also* fails on React 16+. react-dom attaches a value
tracker to each controlled input (it redefines the `value` property on the node instance) to
deduplicate events. Your assignment went through React's own descriptor, so the tracker already
holds the new value; when your `input` event arrives, React compares, sees "no change", and
drops it. The working pattern — this is what core's `setNativeValue` in `fill/events.ts` does
(walking the prototype chain for the setter), so call it rather than reimplementing it:

```ts
// Bypass the instance descriptor (React's tracker) via the *prototype* setter,
// so the tracker still holds the old value and the input event registers as a change.
const proto = el instanceof HTMLTextAreaElement
  ? HTMLTextAreaElement.prototype
  : HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
el.dispatchEvent(new Event("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));
```

The same pattern satisfies Vue's `v-model` (which listens to `input`), which is why
`fill/events.ts` calls it React/Vue-proof.

**Act 3 — Ashby only believes keystrokes.** Even the native-setter pattern left some Ashby
fields "empty" as far as their validation was concerned. Their form logic listens for keyboard
events, not just `input` — a value that arrives without keystrokes doesn't count. So the
executor (the extension's content script) has a second gear: per-character simulation
(`keydown` → `keypress` → append one character via the native setter, which fires `input` and
`change` → `keyup`), which is slower but satisfies keystroke listeners. Core supplies the
building blocks (`setNativeValue`, `needsTrustedKeyboard`); adapters opt text-like field kinds
into that gear instead of paying the cost everywhere — the shipped Ashby adapter declares:

```ts
quirks: {
  trustedKeyboardOnly: ["text", "email", "tel"], // these kinds get the per-key path
  settleMs: 400,                                 // debounced validators need a beat before read-back
},
```

The full quirk set (from `types.ts`):

| Quirk | Type | Use it when |
|---|---|---|
| `trustedKeyboardOnly` | `FieldKind[]` | Values of these kinds only register via the per-keystroke path (Ashby-style React forms) |
| `settleMs` | `number` | The form validates or normalises asynchronously — wait this long after filling before reading values back |
| `paginated` | `boolean` | The form spans multiple steps behind Next buttons (Workday-style). The executor traverses them: it fills the visible step, advances, re-discovers, and stops when no forward control remains. Opt in only when you know the ATS paginates — it is never inferred, because Next-button pagination is also what search-result pages have |
| `nextSelector` | `string` | Selector for the control that advances a step. Optional: without it the executor scans for an unambiguous forward label, rejecting anything that also reads like submit or back. Supply it when the ATS has a stable one — the cost of guessing wrong is a half-filled submission |

**The honest limit.** A page that hard-checks `event.isTrusted` cannot be satisfied from a
content script — browsers reserve trusted events for real users, by design, and LarpMaxer does
not try to break that. This is why verification is not optional: after `settleMs`, the executor
reads every value back out of the DOM. A value that didn't stick is reported as `failed` in the
`FillReport`, and the run pauses for the human instead of submitting a half-filled form. We
never trust the fill; we verify it.

## PR checklist

- [ ] Fixture saved to `packages/core/test/fixtures/`, scrubbed of all personal data and tokens
- [ ] Golden `discover()` field list written out explicitly and reviewed line-by-line
- [ ] `matchesUrl` DOM-free; `detect` checks URL and document structure
- [ ] Selectors are stable across page loads (ids/names, never positional)
- [ ] Radio groups collapsed to single fields; Yes/No pairs mapped to `yesno`
- [ ] `required` verified against the live form's own validation
- [ ] `submitSelector` is the actual submit; `successMarkers` copied from a real confirmation
- [ ] Registered in `adapters/registry.ts` before `generic`
- [ ] Manual run on a live posting in review mode — screenshot of the review card in the PR
