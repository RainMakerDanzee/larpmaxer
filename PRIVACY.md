# Privacy

Short version: LarpMaxer has no server. Your data lives in your browser. On the default
on-device model the extension makes no LLM network requests at all — the model ships with
Chrome and runs on your machine. If you choose a cloud provider instead, the only requests it
ever makes go to that provider, using your own API key.

## What is stored, and exactly where

Everything lives in `chrome.storage.local` — local to your Chrome profile on your machine,
never synced (this is deliberately not `chrome.storage.sync`), never transmitted to us. There
is no "us" to transmit to. These are the exact keys:

| Key | Contents |
|---|---|
| `profile` | Your `Profile`: name, email, phone, location, links, work rights, notice period, salary expectation, summary, skills, experience, education, the Q&A bank, and resume metadata |
| `resume:<id>` | The bytes of one uploaded resume file (base64), keyed by its `ResumeRef` id |
| `settings` | Autonomy mode (`review` or `auto`) plus your `LlmConfig`: provider choice, model name, and your API key if you set one (the default on-device provider has none) |
| `records` | Your `ApplicationRecord` history — which jobs were filled and submitted, when, with what report |
| `queue` | The list of job links you dropped into "Apply to anything", with their status |
| `credentials` | Any portal accounts LarpMaxer created for you (origin + email + the generated password), if you enabled **Create portal accounts for me**. Empty otherwise. |

## What leaves your machine

Exactly two things, both at your instruction:

1. **LLM calls.** When a field needs formatting or selection, the background worker sends the
   form's question and your profile as JSON (resume file bytes excluded) to the provider you
   chose — `api.anthropic.com` or `api.openai.com` — over HTTPS with your key. The Settings
   "Test key" button pings the same provider API directly from the side panel. Those requests
   are governed by that provider's terms and your account's data settings. If you don't want a
   provider to see your profile text, don't configure that provider.
2. **The application itself.** When a form is submitted — after your approval in review mode —
   the filled values and your resume go to the employer's ATS. That is the point of the tool.
3. **Portal registration (opt-in).** If you enabled account creation, a generated password and
   your profile details are sent to the specific employer portal you are applying through — and
   nowhere else. See [SECURITY.md](SECURITY.md) → Credential handling.

## Files written to disk

With **Save artifacts** on (default), after each submission LarpMaxer writes to your browser's
`Downloads/LarpMaxer/` folder: a per-application folder (a summary, the answers given with their
source, the fill report, and the exact resume sent) and a regenerated `ledger.xlsx` with one row
per application. These are local files under your control; nothing is uploaded. Turn the setting
off in **Settings** to stop writing them.

There is no telemetry, no analytics, no crash reporting, no usage pings, and no update phone-home
beyond Chrome's own extension update mechanism if you install from a store. Reading the job page
and filling it happens locally in the content script; nothing about your browsing is reported
anywhere.

## What never leaves

Your API key is sent only to the provider it belongs to. Your resume bytes go only into the
application form you approved. Your Q&A bank and application history never leave
`chrome.storage.local` at all.

## How to delete everything

- **Uninstall the extension.** Chrome deletes all of its `chrome.storage.local` data with it.
  This is the guaranteed full wipe.
- **Wipe without uninstalling:** open the extension's service worker console
  (`chrome://extensions` → LarpMaxer → *service worker*) and run
  `chrome.storage.local.clear()`.
- **Edit selectively:** the profile, Q&A bank, resumes, and key are all editable and deletable
  from the side panel.

Data you already sent to an employer or an LLM provider is governed by them — deleting locally
cannot recall it.
