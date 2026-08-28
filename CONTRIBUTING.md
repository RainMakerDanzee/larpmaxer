# Contributing to LarpMaxer

Thanks for helping people spend less of their lives retyping their own CV.

The product is markdown: [AGENT.md](AGENT.md) (the operating manual) and
[skills/](skills/) (the workflows). There is nothing to build or test locally
— review a change by reading it, or by running the skill in Claude Code
against a real posting.

The highest-leverage contributions, in order:

1. **Playbook fixes from live runs.** You ran `/larpmaxer:apply`, something
   went wrong or sideways — a PR that adds the missing rule (with a one-line
   account of what happened) is exactly how this repo got every rule it has.
2. **ATS knowledge.** Quirks of specific portals (widget behaviour, hidden
   required fields, ordering traps) belong in AGENT.md's applying loop or a
   skill's reminder list — whichever the agent will read at the moment it
   matters.
3. **Sharper skills.** Tighter steps, better failure handling, clearer report
   formats.

Ground rules for any change:

- The non-negotiables in AGENT.md (truthful tailoring, approval gates,
  AI-policy respect, one-question-once) are load-bearing. PRs that weaken them
  will be declined; PRs that enforce them better are the point.
- Write rules the way the existing ones are written: imperative, concrete,
  and justified by something that actually happened.

The archived Chrome extension on the `extension-archive` branch is frozen —
PRs against it won't be reviewed.
