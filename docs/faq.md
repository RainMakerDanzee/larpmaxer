# FAQ

## Is this allowed?

Honest answer: it depends on the site, and you should check.

LarpMaxer automates *your own* applications, one at a time, with your review before anything is
submitted. Functionally it is much closer to a very good autofill than to a scraping bot: it
fills forms you opened, with your real details, at human-visible speed, and in the default mode
you personally approve every submission.

That said, some job boards' terms of service prohibit any automated interaction, and a few ATS
vendors do too. Read the terms of the sites you use it on — that responsibility is yours, and
LarpMaxer does not try to take it from you. Deliberately, it also does not help you around the
enforcement mechanisms: it will not solve CAPTCHAs, will not read your email, and does not
disguise itself. It can create a candidate account on an employer portal — but only after a
one-time consent prompt for that specific site, and you can turn that off entirely in Settings.
If a site puts up a wall LarpMaxer will not cross (a CAPTCHA, an email verification link), the
run stops with a "your turn" card.

Two things it will never do regardless of site policy: submit without a configured approval
path, and put a claim in a form that doesn't come from your profile. What employers receive is
your real information — the same content you would have typed, minus the typing.

## Why do I have to bring my own API key?

Because there is no server. A hosted key would mean your applications — your name, phone,
salary expectations, work history — routing through infrastructure someone else operates. That
is the opposite of the design. With your own key: you pay your provider directly, you can see
every request in your provider dashboard, you can cap and revoke it, and LarpMaxer's authors
never see any of it.

Use a dedicated key with a spending cap. A full application costs a few cents of tokens; most
fields never touch the LLM at all because they resolve straight from your profile or Q&A bank.

## Where does my data live?

In `chrome.storage.local`, in your Chrome profile, on your machine. Profile, Q&A bank, resume
files, API key, application history with its per-field fill reports — all of it. Nothing is
synced and nothing is phoned home. The exact storage keys are listed in
[PRIVACY.md](../PRIVACY.md).

The only data that leaves your machine: LLM requests to the provider you configured (the form
question plus your profile as JSON — resume file bytes excluded), and the applications
themselves when submitted to the employer's ATS.

## How do I delete everything?

Uninstall the extension — Chrome deletes all of its storage with it. To wipe without
uninstalling, run `chrome.storage.local.clear()` in the extension's service worker console, or
delete items individually from the side panel. See [PRIVACY.md](../PRIVACY.md) for details.

## Can it make things up on my behalf?

No, and this is structural rather than a prompt-engineering promise. Fields resolve in a fixed
order: direct profile mapping, then your approved Q&A bank, then the LLM — which is constrained
to select and format from profile facts, its output tagged `source: "llm"` on the resolved
answer. Anything that can't be answered from those sources becomes an intake question for you;
the plan is not executable while unanswered questions remain. And in review mode you see every
value before submit.

## What happens on a login page or a CAPTCHA?

The run pauses and the side panel shows whose turn it is: yours. You log in or solve it, the
run resumes. LarpMaxer never touches credentials — see
"[The rules we won't break](../README.md#the-rules-we-wont-break)".

## Why Chrome only?

MV3 side panel plus `chrome.scripting` covers what the product needs today, and one platform
keeps the extension thin. A Firefox port is on the [roadmap](../README.md#roadmap); the engine
itself (`packages/core`) is browser-agnostic and already runs in plain Node for tests.
