# LarpMaxer for Codex

The same agent, on the OpenAI side. You sign in with your ChatGPT account
(Plus is enough) — no API key. The playbook is identical to the Claude Code
plugin at the root of this repo; only the packaging differs.

## Setup

1. **Install Codex** ([docs](https://learn.chatgpt.com/docs)) and sign in:

   ```
   npm i -g @openai/codex
   codex login
   ```

2. **Install the skills** — pick one:

   **Plugin** (Codex 0.12x+ with the plugin marketplace):

   ```
   codex plugin marketplace add RainMakerDanzee/larpmaxer
   codex plugin add larpmaxer
   ```

   **Copy the skills** (works everywhere):

   ```
   git clone https://github.com/RainMakerDanzee/larpmaxer
   cp -r larpmaxer/codex/skills/* ~/.agents/skills/
   ```

   (Some older Codex versions read `~/.codex/skills/` instead.) Restart Codex
   after installing.

3. **Browser.** The Codex **desktop app** has a browser built in, and the
   Codex Chrome extension lets the agent use your real logged-in Chrome —
   nothing to configure. On the **CLI**, add the Playwright browser once:

   ```
   codex mcp add playwright -- npx @playwright/mcp@latest
   ```

4. **Start.** Make a folder for your job search, drop your resume in it
   (PDF is fine), open Codex there, and run `$larpmaxer-intake`. It installs
   the operating manual into the folder as `AGENTS.md`, reads your resume,
   builds your profile, and asks everything it needs — once, in one batch.

## Daily use

| Skill | What it does |
|---|---|
| `$larpmaxer-apply <link…>` | Paste job links; it does the rest and stops before submit |
| `$larpmaxer-scan` | Finds new matching roles and ranks them honestly |
| `$larpmaxer-tailor <id>` | Tailored resume + cover letter with a claims audit |
| `$larpmaxer-status` | The whole pipeline on one screen |
| `$larpmaxer-followups` | Drafts follow-ups when they're due |

The rules are the same as everywhere LarpMaxer runs: it never invents facts
about you, never submits without your word, never touches your passwords, and
asks each question only once. See
[`skills/larpmaxer-intake/references/AGENTS.md`](skills/larpmaxer-intake/references/AGENTS.md)
for the full manual.
