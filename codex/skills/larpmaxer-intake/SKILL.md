---
name: larpmaxer-intake
description: Onboard a new user — read their resume, build the profile workspace, and capture constraints. Run this first, once.
---

Set up the LarpMaxer workspace in the current folder.

**Step 0 — install the operating manual.** This skill's folder contains
`references/AGENTS.md`. Read it now, then copy it into the current folder as
`AGENTS.md` — Codex auto-loads it here in every later session, so the rules
travel with the workspace. If the workspace already has one, leave it (the
user may have edited it) unless it is older than this skill's copy in ways
the user approves updating.

## Steps

1. **Find the resume.** If `$ARGUMENTS` names a file, use it. Otherwise look for
   a resume-shaped file (pdf/docx/md) in the current folder and confirm it's the
   one; if none, ask the user to drop one in or paste the text.
2. **Read it fully** (you read PDFs natively) and build:
   - `profile/master_resume.md` — the canonical superset: every role, project,
     skill, credential, with dates. Mark anything you inferred rather than read
     as UNCONFIRMED.
   - `profile/evidence_bank.md` — one numbered entry per verifiable fact:
     `E-001 | <claim> | source: resume / user said <date>`. Every future
     tailored bullet must cite one of these.
3. **Copy the resume file** to `profile/` so upload fields always have it.
4. **Ask the intake batch — one message, not a drip.** Only what the resume
   can't answer:
   - Target roles and seniority; locations and remote preference
   - Work rights / visa status in the target country
   - Salary expectation range; notice period
   - Anything on the resume you marked UNCONFIRMED
   - Standard form facts: phone, city, LinkedIn URL, portfolio
5. **Write the answers** into `profile/constraints.md` and `profile/qa_bank.md`
   (seed qa_bank with the classics: work rights, notice period, salary, "why
   this company" scaffold, relocation, start date).
6. **Create** `applications/ledger.csv` with the header row, and empty
   `knowledge/questions.md`, `knowledge/feedback.md`, `knowledge/ats_notes.md`.
7. **Confirm back** a one-paragraph read of who they are and what you'll target,
   and tell them the two commands that matter next: `$larpmaxer-apply <link>`
   and `$larpmaxer-scan`.

If a workspace already exists, don't recreate it — re-read the new resume,
diff it against the profile, and update evidence entries (never silently
overwrite facts the user corrected before; ask about conflicts).
