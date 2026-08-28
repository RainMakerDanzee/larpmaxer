---
name: scan
description: Find new roles matching the user's profile and constraints, score fit, and queue the best into the ledger.
---

Scan for roles matching `profile/constraints.md`. `$ARGUMENTS` may narrow it
(role family, location, "last 24 hours"). Read `${CLAUDE_PLUGIN_ROOT}/AGENT.md` first if you haven't
this session.

## Steps

1. **Search where the ads are** — job boards via the browser pane and web
   search, plus the career pages of any target companies listed in constraints.
   Respect the user's date filter; default to the last week, deprioritise
   anything older than a month.
2. **Dedupe against the ledger** (by canonical URL and company+role) before
   assessing anything.
3. **Assess each candidate** against constraints and the evidence bank. Score
   fit 1–10 with one honest sentence on why — the user's time is the budget,
   so a 5/10 labelled a 5/10 is a feature. Check work-rights and location
   hard-stops first; they veto regardless of fit.
4. **Record**: every assessed role gets a ledger row (`found` or `assessed`)
   with the original URL and source.
5. **Report** a ranked shortlist: company, role, fit score, one-line why,
   posting age, and which ATS it applies through. End by offering
   `/larpmaxer:apply` on the top picks — don't start applying unprompted.
