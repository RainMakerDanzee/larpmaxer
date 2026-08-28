---
name: apply
description: Apply to one or more job links — research, tailor, fill the form in the browser, and gate submission on the user's go-ahead.
---

Apply to the job(s) in `$ARGUMENTS` (one or more URLs, or a tracker id from the
ledger). Follow `${CLAUDE_PLUGIN_ROOT}/AGENT.md`'s "Applying (the agent loop)" section exactly — the
non-negotiable rules apply in full. If no workspace exists yet, run
`/larpmaxer:intake` first.

Reminders that earn their place from live failures:

- **Canonicalize pasted links.** `linkedin.com/jobs/search*?currentJobId=N` is
  the posting `/jobs/view/N/`. Strip SEEK tracking params. Never try to fill a
  search page.
- **Open the browser pane** and read the full ad before writing a word.
  Resolve to the employer's own ATS when one exists.
- **AI-attestation check** before drafting anything (rule 3).
- **Login walls:** pause, name the site, let the user log in themselves in the
  pane, continue after. Never type credentials; never touch a CAPTCHA.
- **Fill → verify each field by reading it back.** Watch for toggle-style
  buttons that deselect on a second click (Ashby). If the form's error
  summary links to a field, follow the link — it focuses the real offender.
- **Multiple links:** process them one at a time to the review gate, then
  present all completed forms together for one batch approval.
- **User away / missing answer:** leave the field blank, batch the question in
  `knowledge/questions.md`, mark the row `waiting-on-you`, move on within about
  a minute rather than stalling the run.
- **After the user approves:** submit, verify the success state, screenshot it,
  save every artifact (tailored resume, answers given, ad text, screenshots) to
  `applications/<id>_<company>_<role>/`, append the ledger row with the
  original URL, set `followup_due` +7 days.

End with a compact report: per job — company, role, status, what's blocked on
whom, and the ledger id.
