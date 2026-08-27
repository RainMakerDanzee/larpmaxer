# LarpMaxer

**Your job applications, filled by an agent you own.**

[![CI](https://github.com/RainMakerDanzee/larpmaxer/actions/workflows/ci.yml/badge.svg)](https://github.com/RainMakerDanzee/larpmaxer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

LarpMaxer is a Chrome extension (Manifest V3) wrapped around a tiny, zero-dependency TypeScript
engine. It fills job application forms from a profile that lives entirely on your machine: it
types what you would type, pauses when it doesn't know something, and — unless you explicitly
opt into auto mode — submits nothing until you have seen exactly what it filled.

<!-- screenshot: side panel open next to a Greenhouse posting, "Fillable: greenhouse" chip visible — docs/img/hero.png -->

## How it works

1. **Visit a posting.** Open a job ad on Greenhouse, Lever, or Ashby, then open the side
   panel — it scans the tab, the matching adapter detects the ATS, and the panel shows
   **Fillable: greenhouse**.
2. **Discover.** LarpMaxer walks the form and builds a typed model of every field — label, kind,
   options, required or not.
3. **Resolve.** Each field is answered from the nearest source, in order: direct profile fields,
   then your approved Q&A bank, then the LLM — constrained to facts in your profile. It never
   invents.
4. **Ask, once.** Anything it can't answer truthfully lands in the side panel's intake queue.
   You answer once; the answer is saved to your Q&A bank and never asked again.
5. **Fill and verify.** The content script types every value with React-proof input events,
   attaches your resume without an OS dialog, then reads every field back to prove it stuck.
6. **You approve.** The review card shows the complete filled form — every value, the resume
   filename. You click **Approve & Submit**; LarpMaxer clicks submit, verifies the success
   message, and records the application.

<!-- gif: the full fill-review-approve loop on a Lever posting — docs/img/fill-loop.gif -->

## Quickstart

Requires Node 20+ and Chrome.

```bash
git clone https://github.com/RainMakerDanzee/larpmaxer
cd larpmaxer
npm install
npm run build
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select
   `packages/extension/dist`.
2. Click the LarpMaxer toolbar icon to open the side panel.
3. Fill in your profile — the editor maps 1:1 to the `Profile` type, and
   [`examples/profile.example.json`](examples/profile.example.json) shows every field filled in.
   Add your Anthropic or OpenAI API key under **Settings**.
4. Visit a Greenhouse, Lever, or Ashby posting and press **Fill**.

## The rules we won't break

These are product rules, not settings:

- **Truthful fill, from your profile only.** Every answer traces to your profile or to an answer
  you typed during intake. The LLM selects and formats; it never invents employers, dates,
  skills, or claims.
- **Unknown questions pause the run.** LarpMaxer asks you in the side panel, then remembers the
  answer in your Q&A bank so you are never asked twice.
- **You own logins and CAPTCHAs.** LarpMaxer never types passwords or one-time codes, never
  creates accounts, and never solves CAPTCHAs. It shows a "your turn" card and waits.
- **Review before submit.** By default nothing is submitted until you approve the full
  filled-form artifact. Auto mode is an explicit opt-in you flip in Settings, and either way
  every run is recorded in History with its per-field fill report.
- **100% local, BYO API key, zero telemetry.** Profile, Q&A bank, key, and application history
  live in `chrome.storage.local`. The only network calls are to the LLM provider you
  configured, with your own key. See [PRIVACY.md](PRIVACY.md).

## Supported ATS

| ATS | Adapter id | Status | Notes |
|---|---|---|---|
| Greenhouse | `greenhouse` | Supported | Hosted boards and embedded forms |
| Lever | `lever` | Supported | `jobs.lever.co` postings |
| Ashby | `ashby` | Supported | React form; trusted-keystroke quirk handled |
| Everything else | `generic` | Best effort | Label/ARIA-based discovery — review the artifact carefully |

Yours missing? An adapter is a small pure function pair plus a fixture-driven test —
[write one in about 30 minutes](docs/adapters.md).

## Architecture

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

Two packages. `packages/core` is the engine — pure TypeScript, zero runtime dependencies, runs
in Node for tests: detect → discover → resolve → fill → verify, plus the adapter registry and
the Anthropic/OpenAI providers. `packages/extension` is the MV3 product — background
orchestrator (state machine, LLM calls, storage), a thin content script that executes fill
plans, and the Preact side panel. Full details, module map, and data flow:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Roadmap

- **Workday adapter** — paginated multi-step forms; the reference case for `quirks.paginated`
- **SEEK** and other login-walled boards — human-assisted flow (you log in, LarpMaxer fills)
- **Batch mode** — queue several postings, answer intake once, review them all in one sitting
- **Desktop companion** — for the steps a browser extension can't reach
- **Firefox** port

## Contributing

Adapters are the best entry point — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup,
the test-first adapter workflow, and a list of good first adapters.

## License

MIT — see [LICENSE](LICENSE).
