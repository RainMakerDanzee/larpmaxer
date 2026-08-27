# Security Policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). Do not open a public issue for anything exploitable.

This is a small open-source project: expect an acknowledgement within a few days, best-effort
fixes, and full credit in the release notes if you want it.

## Supported versions

The latest release and `main`. There are no backports.

## What LarpMaxer refuses to do, by design

The most important security properties are things the product deliberately does not do:

- **No CAPTCHA or bot-detection bypass.** A CAPTCHA pauses the run with a `HUMAN_NEEDED`
  message and hands control back to the user.
- **No inbox access.** LarpMaxer never reads the user's email. When a portal sends a
  verification link, the run pauses and asks the user to click it — the extension requests no
  mail scopes and holds no mail credentials.
- **Least privilege.** Extension permissions are `storage`, `sidePanel`, `scripting`,
  `activeTab`, `downloads` (to write the per-application artifacts and `ledger.xlsx`), and
  `tabs` (to read the URL of the background tab a queued link opens in). Fixed host permissions
  cover the two LLM APIs (`api.anthropic.com`, `api.openai.com`). ATS host access is granted
  per-site by the user via optional host permissions — never `<all_urls>` by default.
- **Minimal supply chain.** `packages/core` has zero runtime dependencies; the extension ships
  Preact and nothing else. There is no server, no telemetry endpoint, and no analytics SDK to
  compromise.
- **LLM calls only from trusted extension surfaces.** Answer resolution calls the provider from
  the background service worker; the side panel's Settings "Test key" probe pings the same two
  provider APIs. The API key is sent only to the configured provider — it never enters a
  content script, and never enters the page.

## Credential handling (opt-in, consent-once)

Some employer portals require a candidate account before you can apply. With the
**Create portal accounts for me** setting on (default), LarpMaxer will, *after a one-time
consent prompt for that specific site*:

- generate a strong random password (`crypto.getRandomValues`, 20 chars) and fill the portal's
  registration form from your profile;
- store that one credential in `chrome.storage.local` under the `credentials` key, so the same
  account can be reused on later visits.

Design limits that bound the risk:

- **Origin-locked fill.** The content script refuses to type a stored credential unless the live
  document's origin exactly matches the origin the credential was minted for — a redirect or
  soft navigation between detection and fill aborts the fill rather than leaking the password.
- **No inbox, no CAPTCHA.** Email verification and CAPTCHAs still pause for the human.
- **Local only.** The generated password is sent only to the portal that account is for; it is
  never transmitted anywhere else, and the browser's own password manager is offered as the
  primary store.
- **Off switch.** Turn the setting off in **Settings** and LarpMaxer reverts to pausing at every
  login wall. It never touches passwords for accounts *you* already own — only ones it created.

This is a genuine trade-off, made explicit: the convenience of not stopping at every HR portal,
in exchange for a locally-stored generated password per portal. It is not the same as handling
your existing passwords, which LarpMaxer never does.

## Threat notes

**A malicious page reading injected values.** Values typed into a form necessarily enter the
page world — exactly as if the user typed them by hand. The exposure is scoped: only the
resolved answers for the fields on that page are ever written into it. The full profile, the
Q&A bank, application history, and the API key stay in extension contexts (the content script's
isolated world, the background worker, and `chrome.storage.local`) and are never handed to page
scripts.

**A malicious page phrasing fields to exfiltrate.** A hostile form could label a field "API
key" or "mother's maiden name" hoping the engine autofills it. Mitigations: the answer engine
draws only on profile facts and approved Q&A entries; questions it cannot map are queued to the
human rather than guessed; and in the default review mode every value is shown before submit.
Treat a field you don't recognise in the review artifact as a red flag.

**Your own machine.** The API key sits in `chrome.storage.local`, protected by OS user
permissions but not additionally encrypted — the same trust level as any extension-held key.
Anyone who can run code in your Chrome profile can read it. Use a dedicated, revocable key with
a spending cap, and rotate it if the machine is shared or compromised.

**Fixtures and records.** Test fixtures are sanitised HTML snapshots and must never contain real
personal data (see the checklist in [docs/adapters.md](docs/adapters.md)). The stored application
records stay local; nothing is reported anywhere.
