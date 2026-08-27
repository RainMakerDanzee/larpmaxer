# LarpMaxer Architecture

LarpMaxer fills and submits job applications from a profile the user owns. It is built as a
tiny pure-TypeScript engine (`@larpmaxer/core`) wrapped by a Chrome extension (MV3 side panel).

```
┌─────────────────────────── Chrome ────────────────────────────┐
│  ┌───────────────┐   typed messages   ┌────────────────────┐  │
│  │  Side panel   │◄──────────────────►│ Background worker  │  │
│  │  (Preact UI)  │                    │  orchestrator      │  │
│  │ profile/intake│                    │  + LLM provider    │  │
│  │ review queue  │                    │  (BYO API key)     │  │
│  └───────────────┘                    └─────────┬──────────┘  │
│                                        inject / │ messages    │
│                                                 ▼             │
│                                       ┌────────────────────┐  │
│  ATS page (Greenhouse/Lever/Ashby/…)  │  Content script    │  │
│                                       │  @larpmaxer/core:   │  │
│                                       │  detect → discover │  │
│                                       │  → fill → verify   │  │
│                                       └────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

## Packages

### `packages/core` — the engine (zero runtime dependencies)
| Module | Responsibility |
|---|---|
| `types.ts` | Every shared contract: `Profile`, `FormField`, `FillPlan`, `Adapter`, messages. Single source of truth. |
| `profile.ts` | Profile validation (hand-rolled — no zod), `emptyProfile`, question normalisation, Q&A bank merge. |
| `answers.ts` | Maps a `FormField` to an answer: direct profile fields → Q&A bank → LLM (evidence-constrained) → `needsUser`. |
| `fill/events.ts` | React/Vue-proof input: native prototype setters + `input`/`change` events, checkbox/option click helpers, `needsTrustedKeyboard`. |
| `fill/files.ts` | Resume attach without OS dialogs: bytes → `File` → `DataTransfer` → `input.files` + `change`. |
| `fill/dom.ts` | Field-discovery helpers: label resolution, visibility checks, selector lookup, value read-back, the ARIA combobox dance. |
| `adapters/` | Per-ATS knowledge: `greenhouse` / `lever` / `ashby` / `generic` (the fallback, kept last). `registry.ts` holds the ordered list; `pickAdapter` takes the first whose `matchesUrl` + `detect` both pass. |
| `llm/` | Provider factory (`createProvider`, `DEFAULT_MODELS`, `LlmError`) + Anthropic/OpenAI implementations, evidence-pinned prompts, `makeLlmDelegate` bridge into `answers.ts`. |
| `ledger.ts` | Zero-dependency `.xlsx` writer for the application ledger (hand-rolled OOXML + STORE zip). |
| `registration.ts` | Auth-wall classification and login/registration form discovery (pure over the document). |
| `messages.ts` | Runtime guard for the typed message protocol (`isLarpMaxerMessage`); the `Message` union itself lives in `types.ts`. |
| `index.ts` | The package barrel — the only supported import surface. |

Rules: strict TS, no `any` in exported signatures, every exported symbol has JSDoc. DOM types
stay confined to `fill/*`, `adapters/*`, and the `Adapter` contract in `types.ts` — everything
else must run in Node (tests/CLI).

### `packages/extension` — the product (MV3)
- `background/` service worker: per-tab run state machine over core's `RunPhase`
  (idle → detecting → discovering → resolving → awaiting_user → registering → filling → review → submitting →
  done/error), answer resolution + LLM calls (never from content scripts), storage,
  per-site permission grants. Injects the content script on demand via `chrome.scripting`.
- `background/queue.ts` — the "apply to anything" link queue: dropped URLs open in background
  worker tabs, run the same pipeline one at a time, and narrate progress as `QUEUE_STATE`.
- `background/artifacts.ts` — after every submission, saves a per-application folder
  (summary, answers + sources, fill report, the exact resume) plus a regenerated
  `ledger.xlsx` to Downloads/LarpMaxer (zero-dep xlsx writer in `core/ledger.ts`).
- `content/` thin: receives a `FillPlan`, executes it with core's fill modules, reports a `FillReport`.
- `sidepanel/` Preact UI, four tabs: Run (detect state, intake queue for unanswered questions,
  review artifact with Approve & Submit / Cancel, "your turn" card), Profile editor,
  History (stored `ApplicationRecord`s, live-updated), Settings (autonomy, provider, model, key).
- `lib/` typed messaging helpers shared by all three surfaces (plus the ping/pong liveness probe).
- Permissions: `storage`, `sidePanel`, `scripting`, `activeTab`, plus fixed host permissions for
  the two LLM APIs (`api.anthropic.com`, `api.openai.com`); ATS host access is granted per-site
  by the user (optional host permissions) — never `<all_urls>` by default.

## Non-negotiable product rules
1. **Truthful fill.** Every answer traces to the user's profile or their explicit intake answer.
   The LLM formats and selects; it never invents facts. Unknown → pause and ask; answer is saved to
   the Q&A bank so it is never asked twice.
2. **Humans own existing credentials.** LarpMaxer never types passwords for accounts the user
   already has, never reads email, and never solves CAPTCHAs — those pause with a "your turn"
   card. It may create a *new* portal account with a generated password, but only after a
   one-time per-site consent and only when the `autoRegister` setting is on; the fill is
   origin-locked (see docs/registration.md).
3. **Approval gate default.** `review` mode shows the full filled-form artifact before submit.
   `auto` mode is an explicit opt-in in Settings; even then every run is recorded as an
   `ApplicationRecord` with its per-field `FillReport`.
4. **Local-first.** Profile, Q&A bank, API key, application history live in `chrome.storage.local`.
   No telemetry, no server, no analytics. The only network calls are the user's own LLM provider.

## Data flow of one application
1. User opens a job posting and the side panel; the panel scans the tab, the background injects
   the content script, and the matching adapter's `detect` → "Fillable: greenhouse".
2. Background asks the content script to run the adapter's `discover(doc)` → `FormField[]`.
3. `answers.ts` resolves each field → `FillPlan` (+ `needsUser[]` queued to intake).
4. Content script executes plan (`fill/*`), returns `FillReport` (field, value, verified).
5. Review card: artifact preview (all values + resume name). Approve → content clicks submit,
   verifies success text, background stores an `ApplicationRecord`.

## Testing
- `vitest` + jsdom. Adapters are tested against saved DOM fixtures per ATS
  (`packages/core/test/fixtures/*.html`); fill modules against synthetic jsdom documents.
- Each adapter ships with a fixture and a golden `discover()` field list, written out explicitly
  in `test/adapters.test.ts` so reviewers read it line-by-line. CI = typecheck + test + build.

## Renaming / forking
The user-facing name lives in the `package.json` files, `manifest.json`, and the docs; source
code uses lowercase `larpmaxer` only in error-message prefixes, the `LARPMAXER_PING`/`LARPMAXER_PONG`
liveness probe, and the `data-larpmaxer-submit` marker attribute. `rg -i larpmaxer` finds every
site; nothing is functionally hard-wired.
