# Testing

Five layers. `npm test` runs the first three (vitest + jsdom); `npm run e2e` runs the
fourth in a real browser. Only the live smoke test is manual.

| Layer | Where | What it proves |
|---|---|---|
| **Unit** | `packages/core/test/{profile,answers,fill,llm,ledger}.test.ts` | The engine's contracts: answer resolution order, React-proof fill events, file attach, xlsx structure, LLM delegate validation. |
| **Adapter fixtures** | `packages/core/test/adapters.test.ts` + `test/fixtures/*.html` | Each ATS adapter's `detect`/`discover` against saved real-world form shapes, with explicit expected-field lists. New adapters must ship a fixture. |
| **Security** | `packages/core/test/security.test.ts` + regression cases in `registration.test.ts`, `adapters.test.ts` | Attack models: xlsx formula/XML injection, hostile fake auth walls, credential-field exclusion, LLM prompt containment (page text never reaches the system role). |
| **End to end** | `packages/extension/e2e/run.mjs` (`npm run e2e`) | The built MV3 extension loaded into Chromium, driven the way the side panel drives it: detect the adapter, resolve answers, fill the form, read every field back, submit, verify the ATS success message, and confirm the run was recorded. Proves the wiring between service worker, content script and message protocol — the part no Node test can reach. |
| **UI / UX** | `sidepanel/demo.html` (the shimmed real app) | Manual click-through of every state: queue lifecycle, intake, review artifact, consent card, settings. Run it before any release: `npm run build`, serve `dist/sidepanel/`, open `demo.html`. |
| **Live smoke** | A real Greenhouse/Lever/Ashby posting | One supervised end-to-end fill per release, review gate on. The Ashby quirks in this repo were all found this way. |

## Rules
- A bug fix lands with the test that would have caught it.
- Adapters: fixture + explicit `discover()` field list, no snapshots — reviewers read them.
- Anything touching fill or credentials gets a case in `security.test.ts` modelling the abuse.

## Running the end-to-end test

```bash
npm run build && npm run e2e
```

It needs a Chromium (`npx playwright install chromium`, or point `CHROMIUM_PATH` at one).
The fixture is served over https under the real `boards.greenhouse.io` hostname, mapped to
localhost, because LarpMaxer refuses plain http and picks its adapter by host — a test that
worked around either would stop exercising the real entry conditions. Set `E2E_DEBUG=1` to
echo browser console output; a failed wait reports the run's own last state.

## CI
`.github/workflows/ci.yml` runs two jobs on every push/PR: typecheck → test → build (which
uploads the built extension as an artifact), and the end-to-end run in a real browser.
