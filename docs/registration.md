# Autonomous account creation — design (v0.2 target)

Many employer portals (SuccessFactors, Workday, eziJob, iCIMS…) demand a candidate account
before the application form. Today that is a hard "your turn" stop. This design removes it:
LarpMaxer registers for the user — asking once per portal, ever.

## Product behaviour

1. Run hits a registration/login wall → the panel shows a one-time consent card:
   > **New portal: careers.arn.com.au**
   > LarpMaxer will create an account with **jordan@example.com** and a generated password
   > (saved to your browser's password manager).
   > [ Create account — always allow this site ] [ Just this once ] [ I'll do it myself ]
2. On consent: fill the registration form from the profile, submit, and store the credential.
3. Email verification: most portals send a link/code. LarpMaxer does NOT read email
   (deliberately — inbox scopes are a trust and review minefield). The queue card flips to
   **"Tap the verification link we just triggered — check your email"** and the run resumes
   the moment the portal session works. One tap, once per portal, ever.
4. Next time on that portal: log in with the stored credential automatically (allowed-listed
   site + form-filling only — this is the product acting as the user's own password manager,
   the same trust model as Chrome's built-in one).

## Mechanics

- **Credential vault**: `PortalCredential { origin, email, password, createdAt, lastUsedAt }`
  in `chrome.storage.local`, plus standard `autocomplete="new-password"` semantics on fill so
  the browser's own password manager offers to save — the browser vault is the primary store,
  ours is the fallback for headless resumption.
- **Password generation**: 20 chars, cryptographically random (`crypto.getRandomValues`),
  charset satisfying the common portal policies (upper/lower/digit/symbol).
- **Registration discovery**: adapter-level. Each adapter gains optional
  `registration?: { detect(doc): boolean; discover(doc): FormField[]; submitSelector: string }`.
  The generic adapter handles the common shape (email + password + confirm + name fields).
- **New run phases**: `registering`, `awaiting_verification` (a `HUMAN_NEEDED` reason
  `verify_email` already fits the protocol shape).
- **Login walls** on known portals: if a stored credential exists → fill and continue
  (no consent needed — it was granted at creation). If none → consent card offers
  create-or-manual.
- **Never**: solve CAPTCHAs, read inboxes, reuse one password across portals, or send
  credentials anywhere off-device.

## Status

- [x] Design (this doc)
- [x] Contract: `PortalCredential` type + vault storage helpers
- [ ] Consent card UI (panel)
- [ ] Generic registration adapter + per-ATS registration blocks (SuccessFactors, eziJob first
      — the two walls hit in live testing 2026-08-27)
- [ ] `registering` / `verify_email` states in the run machine + queue
