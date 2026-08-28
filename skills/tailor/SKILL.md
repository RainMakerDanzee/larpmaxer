---
name: tailor
description: Produce a tailored resume and cover letter for one role, with a claims audit proving every line is true.
---

Tailor materials for the role in `$ARGUMENTS` (ledger id or URL). Read
`${CLAUDE_PLUGIN_ROOT}/AGENT.md` first if you haven't this session; read `knowledge/feedback.md`
before writing a word — it holds the user's corrections and voice preferences.

## Steps

1. **Read the ad in full** (browser pane if it's a URL). List the top 5 things
   this employer is actually screening for, in their language.
2. **Select and reorder** from `profile/master_resume.md`: lead with the
   experience that answers those 5 things. Reword bullets toward the ad's
   vocabulary — but every bullet must still trace to an evidence entry.
   Cutting is tailoring; padding is lying.
3. **Cover letter** (only if the application takes one): short, specific,
   theirs-not-generic. Quote or reference one concrete line from the ad, name
   one true reason this user fits it, close plainly. No "I am writing to
   express", no adjectives doing the work evidence should.
4. **Claims audit** — mandatory, written into the package folder:
   a table of every claim in the tailored materials → its E-### id. A claim
   with no id gets cut or sent to the user as a question, never shipped.
5. **Save** to `applications/<id>_<company>_<role>/`: tailored resume (md +
   the format the portal wants), cover letter, claims audit, and the ad text
   itself (ads get taken down; keep the evidence).
6. **Show the user** the tailored resume diff-style — what was emphasised,
   what was cut, and why — so approval is fast.
