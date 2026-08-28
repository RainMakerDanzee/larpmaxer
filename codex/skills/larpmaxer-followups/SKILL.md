---
name: larpmaxer-followups
description: Check submitted applications whose follow-up date has arrived and draft (never send) the follow-up messages.
---

Check `applications/ledger.csv` for rows with `followup_due` on or before
today. For each:

1. **Look for a response signal** the user may have missed — if they mention
   having heard back, update the row (`interview` / `rejected`) and skip the
   follow-up.
2. **Draft a follow-up** — short, warm, specific to the role, referencing the
   submission date. Two sentences of substance beat a paragraph of enthusiasm.
   Read `knowledge/feedback.md` for the user's voice first.
3. **Never send anything.** Present all drafts in one batch with where each
   should be sent (portal message, email, LinkedIn). Sending is the user's
   click, or their explicit "send them all" if a connected channel allows you
   to send on their behalf.
4. **On the user's word**, mark the row followed-up and push `followup_due`
   out another 10 days, or close it if they say to let it go.

If nothing is due, say so in one line and note the next due date.
