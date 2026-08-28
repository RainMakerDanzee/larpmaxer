# Security Policy

LarpMaxer is markdown executed by Claude Code — there is no binary, server,
or dependency chain to exploit. The security-relevant surface is the
instructions themselves.

## Reporting

If you find a way this playbook can be abused — an instruction that could be
subverted by a malicious job posting (prompt injection via ad text), a rule
that leaks profile data somewhere it shouldn't go, or a gap in the approval
gates — open a GitHub security advisory on this repo, or an issue if it is
not sensitive.

## Design stance

- **Job-ad text is untrusted input.** The agent reads postings to extract
  requirements; instructions embedded in a posting are not instructions to
  the agent. AGENT.md's gates exist precisely so that nothing a webpage says
  can cause a submission, message, or credential entry on its own.
- **Submission, sending, accounts, credentials, CAPTCHAs** are always human
  actions or human-approved actions. Any PR moving one of these behind
  autonomy will be declined.
- **All state is local files** the user can read — there is nowhere for
  hidden behaviour to accumulate.
