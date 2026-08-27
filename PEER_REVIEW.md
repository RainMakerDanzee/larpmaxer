# Peer review protocol

Every substantial change gets a second set of eyes — human when available, an external
LLM otherwise. This file is the runbook.

## When
- Before any tagged release or Chrome Web Store submission.
- After changes to: fill primitives, credential/registration code, message protocol,
  manifest permissions, the LLM prompts.
- On request ("run a peer review").

## How (external LLM, e.g. ChatGPT)

1. Generate the review bundle:
   ```bash
   git diff main...HEAD > review.diff        # or the full files for a release review
   npm run typecheck && npm test             # paste the summary line too
   ```
2. Paste the prompt below, attach/paste `review.diff` (plus `ARCHITECTURE.md` on first run).
3. File every finding as an issue or fix it before merging. Findings the reviewer got
   wrong get a one-line rebuttal in the PR description — silent dismissal is not review.

### Ready-to-paste reviewer prompt

> You are reviewing a Chrome MV3 extension ("LarpMaxer") that fills job applications from
> a locally stored user profile. Architecture: a zero-dependency TypeScript core
> (adapters for Greenhouse/Lever/Ashby + generic, form-fill primitives, an xlsx writer,
> auth-wall detection, LLM client) and an extension package (background service worker,
> content script injected into job sites, Preact side panel).
>
> Non-negotiable product rules you must verify are not violated by this change:
> 1. Truthful fill — every answer traces to the user's profile; unknowns pause and ask.
> 2. Humans own credentials — no password harvesting; generated portal passwords stay in
>    local storage / the browser's password manager; content scripts never read
>    password fields belonging to the user.
> 3. Review-before-submit default; auto-submit is explicit opt-in.
> 4. Local-first — no telemetry, no calls except the user's own LLM provider.
>
> Review the attached diff as a hostile senior engineer. Report, in order:
> (a) security issues — assume job pages are attacker-controlled (message spoofing,
> injection into xlsx/markdown/downloads paths, credential exfiltration, prompt
> injection); (b) correctness bugs with a concrete failing scenario; (c) API/readability
> problems worth blocking on. For each: file, line, severity, minimal fix. Do not pad
> with style nitpicks. Finish with a verdict: merge / fix-first / redesign.

## Internal checklist (attach to the PR)
- [ ] `npm run typecheck` clean · `npm test` green · `npm run build` produces loadable dist
- [ ] New/changed behaviour has tests (see TESTING.md layers)
- [ ] Demo page still walks through end to end
- [ ] No new permissions in `manifest.json` (or the PR explains and minimises them)
- [ ] Docs updated where behaviour changed (README, ARCHITECTURE, docs/*)
- [ ] External reviewer's findings addressed or rebutted in writing
