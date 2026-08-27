# Contributing to LarpMaxer

Thanks for helping people spend less of their lives retyping their own CV. The highest-leverage
contribution is an adapter for an ATS we don't cover yet — see the
[good first adapters](#good-first-adapters) below and the full walkthrough in
[docs/adapters.md](docs/adapters.md).

## Dev setup

You need Node 20+ and Chrome. The repo is an npm workspace with ESM everywhere.

```bash
git clone https://github.com/RainMakerDanzee/larpmaxer
cd larpmaxer
npm install
npm run build       # bundles the extension into packages/extension/dist (core is source-first — no build step)
npm test            # vitest (jsdom) across the workspace
npm run typecheck   # tsc -b over both packages — strict, no emit
```

Load the built extension once: `chrome://extensions` → **Developer mode** → **Load unpacked** →
`packages/extension/dist`. The dev loop after that is: rebuild, click the reload icon on the
extension card, then hit **Scan page** again — the content script is injected on demand when a
run starts, never via the manifest. Reload the ATS tab if a stale copy is still answering, and
reopen the side panel if it went stale.

Core has no Chrome dependency at all — most work on adapters and fill logic happens entirely in
Node against fixtures, and only the final manual pass touches a real browser.

## Repo tour

The layout mirrors [ARCHITECTURE.md](ARCHITECTURE.md), which is the binding document. In brief:

```
packages/core/src/
  types.ts        every shared contract — the single source of truth; nothing redefines these
  profile.ts      profile validation, emptyProfile, question normalisation, Q&A bank merge (hand-rolled, no zod)
  answers.ts      FormField → answer: profile → Q&A bank → LLM (evidence-constrained) → needsUser
  fill/events.ts  React/Vue-proof input: native prototype setters + input/change events
  fill/files.ts   resume attach without OS dialogs (bytes → File → DataTransfer)
  fill/dom.ts     field-discovery helpers: labels, visibility, read-back, the combobox dance
  adapters/       one file per ATS + generic.ts fallback; registry.ts picks the first match
  llm/            provider factory + Anthropic/OpenAI implementations, prompts, answer delegate
  messages.ts     runtime guard for the message protocol (the Message union lives in types.ts)
packages/core/test/
  fixtures/       saved DOM snapshots per ATS (*.html) — the adapter contract
packages/extension/src/
  background/     service worker: run state machine, LLM calls, storage, permissions
  content/        thin executor: receives a FillPlan, runs core's fill modules, reports back
  sidepanel/      Preact UI tabs: Run (intake queue + review artifact), Profile, History, Settings
  lib/            typed messaging helpers shared by all three surfaces
docs/             adapter walkthrough, FAQ, side-panel design spec
examples/         profile.example.json — a complete fictional Profile
```

## House rules

These are enforced in review, and most of them in CI:

- **`packages/core` has zero runtime dependencies.** Not one. Dev dependencies (vitest, jsdom,
  typescript) are fine.
- **Strict TypeScript.** No `any` in exported signatures. Every exported symbol gets a one-line
  JSDoc.
- **Types come from `types.ts`.** Import them; never redefine or fork them. If a contract needs
  to change, that is its own PR with its own discussion.
- **No DOM types outside `fill/`, `adapters/`, and the `Adapter` contract in `types.ts`.**
  Core must run in Node.
- **Small files, clear names, no clever abstractions.** Comments exist to explain non-obvious
  constraints, not to narrate code.
- **The four product rules in ARCHITECTURE.md are not up for PR** — truthful fill, humans own
  credentials, approval gate default, local-first. Features that erode them will be declined
  kindly and firmly.

## The adapter workflow (test-first)

Adapters are written against saved fixtures, not against live sites, so they are reviewable and
they never rot silently:

1. **Save a fixture.** Snapshot a real application form's DOM into
   `packages/core/test/fixtures/<ats>.html` and scrub any personal data.
2. **Write the golden test first.** A `discover()` test that spells out the full expected field
   list against the fixture (the house style — see `test/adapters.test.ts`). It fails; good.
3. **Implement** `matchesUrl` → `detect` → `discover` → `submitSelector` / `successMarkers`
   until the golden list is one you would sign your name to.
4. **Manual pass** on a live posting in review mode. Screenshot the review card for your PR.

The full walkthrough — including the fixture checklist and the React/Ashby war story — is in
[docs/adapters.md](docs/adapters.md).

## PR expectations

- One change per PR. Adapter PRs contain the adapter, its fixture, and its golden field list.
- CI (typecheck + tests + build) green before requesting review.
- Golden field lists are reviewed line-by-line — write them so a reviewer can, and change them
  only deliberately (edit the expected list plus a sentence in the PR about what changed and why).
- No new network calls anywhere, ever, except inside `llm/` provider implementations. (The one
  existing exception: the Settings "Test key" probe calls the same two provider APIs from the
  side panel.)
- UI changes to the side panel include a screenshot.
- Plain, descriptive commit messages. No fixup noise in the final branch.

## Good first adapters

All of these have public, login-free application forms and are realistic 30-to-90-minute
projects. Open an issue to claim one so two people don't build it at once:

| ATS | Forms hosted at | Why it's a good start |
|---|---|---|
| Workable | `apply.workable.com` | Clean single-page form, stable `data-ui` attributes |
| Recruitee | `*.recruitee.com` | Simple markup, well-labelled fields |
| Teamtailor | `*.teamtailor.com` | Straightforward, a couple of comboboxes to map |
| BambooHR | `*.bamboohr.com` | Plain fields, good label association |
| Pinpoint | `*.pinpointhq.com` | Tidy forms, standard uploads |
| SmartRecruiters | `jobs.smartrecruiters.com` | Well-structured but multi-step — needs `quirks.paginated`, which the executor now honours |

Harder, and worth discussing in an issue first: Workday (paginated + account walls, on the
roadmap), iCIMS (iframe soup), SEEK and other boards that require login (needs the
human-assisted flow).
