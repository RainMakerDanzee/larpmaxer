# Testing

Five layers. `npm test` runs the first three (148 tests, vitest + jsdom); the rest are
manual today with automation planned.

| Layer | Where | What it proves |
|---|---|---|
| **Unit** | `packages/core/test/{profile,answers,fill,llm,ledger}.test.ts` | The engine's contracts: answer resolution order, React-proof fill events, file attach, xlsx structure, LLM delegate validation. |
| **Adapter fixtures** | `packages/core/test/adapters.test.ts` + `test/fixtures/*.html` | Each ATS adapter's `detect`/`discover` against saved real-world form shapes, with explicit expected-field lists. New adapters must ship a fixture. |
| **Security** | `packages/core/test/security.test.ts` + regression cases in `registration.test.ts`, `adapters.test.ts` | Attack models: xlsx formula/XML injection, hostile fake auth walls, credential-field exclusion, LLM prompt containment (page text never reaches the system role). |
| **UI / UX** | `sidepanel/demo.html` (the shimmed real app) | Manual click-through of every state: queue lifecycle, intake, review artifact, consent card, settings. Run it before any release: `npm run build`, serve `dist/sidepanel/`, open `demo.html`. Planned: Playwright against the demo page in CI. |
| **Live smoke** | A real Greenhouse/Lever/Ashby posting | One supervised end-to-end fill per release, review gate on. The Ashby quirks in this repo were all found this way. |

## Rules
- A bug fix lands with the test that would have caught it.
- Adapters: fixture + explicit `discover()` field list, no snapshots — reviewers read them.
- Anything touching fill or credentials gets a case in `security.test.ts` modelling the abuse.

## CI
`.github/workflows/ci.yml`: typecheck → test → build on every push/PR; uploads the built
extension as an artifact.
