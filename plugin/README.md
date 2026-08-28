# LarpMaxer Agent

Your job search, run by an agent in Claude Code. You bring a resume and a
Claude account; it researches roles, tailors materials that stay true to your
actual experience, fills the forms in a real browser, and submits only when
you say go.

This is the plugin version of LarpMaxer — the packaging of a playbook that was
battle-tested live: real applications researched, tailored, filled, and
submitted across Ashby, SEEK, and LinkedIn with a human approving every send.
The browser extension in this repo fills forms deterministically; this plugin
is the full agent.

## Setup (once, ~3 minutes)

1. Install [Claude Code](https://claude.com/claude-code) (desktop app or CLI)
   and sign in with your Claude account. No API key — your subscription is the
   engine.
2. Add the plugin:

   ```
   /plugin marketplace add RainMakerDanzee/larpmaxer
   /plugin install larpmaxer@larpmaxer
   ```

3. Make a folder for your job search, drop your resume in it (PDF is fine),
   open Claude Code there, and run:

   ```
   /larpmaxer:intake
   ```

   It reads your resume, builds your profile, and asks everything it needs —
   once, in one batch.

## Daily use

| Command | What it does |
|---|---|
| `/larpmaxer:apply <link…>` | Paste one or more job links; it does the rest and stops before submit |
| `/larpmaxer:scan` | Finds new matching roles and ranks them honestly |
| `/larpmaxer:tailor <id>` | Tailored resume + cover letter with a claims audit |
| `/larpmaxer:status` | The whole pipeline on one screen |
| `/larpmaxer:followups` | Drafts follow-ups when they're due |

## The rules it won't break

- **It never lies on your behalf.** Every tailored claim traces to an evidence
  entry built from your real resume and answers. Rewording and reordering, yes;
  inventing employers, dates, or metrics, never.
- **It never submits without you.** Filling is autonomous; the submit click
  waits for your word ("submit all 5" works). Logins are yours to type,
  CAPTCHAs are yours to solve, and it pauses to hand you the browser.
- **It respects no-AI policies.** If an employer asks applicants to attest they
  wrote materials without AI, it does the research and hands you the pen.
- **It asks once.** Every question you answer is saved and reused; a fact it
  can't find is left blank and batched, not guessed.

Everything it does lives in plain files next to your resume — the profile, a
ledger CSV of every application with original links, and a folder of artifacts
per application. Yours to read, edit, or take elsewhere.
