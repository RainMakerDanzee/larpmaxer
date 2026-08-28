---
name: larpmaxer-status
description: Report the state of the pipeline — every application, what's blocked on whom, and what happens next.
---

Read `applications/ledger.csv` and report the pipeline. No browser needed.

- **Needs the user**: rows in `awaiting-approval`, `needs-you`,
  `waiting-on-you`, `manual-only` — each with what specifically is needed and
  the link to act on. Unanswered items in `knowledge/questions.md` go here too,
  asked as one batch.
- **In flight**: `found`/`assessed`/`packaged` — what the agent will do next.
- **Submitted**: count, plus any with `followup_due` within 3 days.
- **Outcomes**: interviews and rejections, if any.

Keep it to one screen. Numbers first, then only the rows that need attention.
If `$ARGUMENTS` names a company or id, deep-dive that one instead: full
history, artifacts on disk, and next action.
