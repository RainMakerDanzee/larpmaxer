# LarpMaxer Design System — "studio grade"

> **Status: shipped.** `packages/extension/src/sidepanel/styles.css` implements this system —
> tokens, bundled fonts, the elevation scale, and the responsive panel/wide layouts.

Inspiration: mapo.studio (analyzed 2026-08-27). We lift the *system*, not the brand: warm-light
minimalism, one electric lime, soft-black cards for rhythm, mono microcopy, big friendly type at
regular weight. Everything below is implementable in the side panel today.

## Tokens

```css
:root {
  /* color */
  --ink:        #1e1e1e;   /* soft black — never #000 */
  --ink-2:      #323232;
  --ink-3:      rgba(50, 50, 50, .5);
  --paper:      #ffffff;
  --paper-warm: #fcfff5;   /* warm tint — app background */
  --surface:    #f6f6f6;   /* quiet cards */
  --lime:       #d4fa70;   /* THE accent. Use sparingly: primary action, success, one hero card */
  --lime-ink:   #1e1e1e;   /* text on lime is always ink, never white */
  --hairline:   rgba(0, 0, 0, .10);
  --hairline-2: rgba(0, 0, 0, .05);

  /* type */
  --font-sans:  "Manrope", system-ui, sans-serif;        /* Aeonik stand-in */
  --font-mono:  "IBM Plex Mono", ui-monospace, monospace; /* Aeonik Mono stand-in */
  --font-serif: "Instrument Serif", Georgia, serif;       /* P22 Mackinac stand-in — accents only */

  /* radius & space */
  --r-s: 6px;  --r-m: 10px;  --r-l: 16px;
  --space-unit: 8px; /* 8-pt grid; sections breathe: 3–6 units between blocks */

  /* motion */
  --ease: cubic-bezier(.22, 1, .36, 1); /* fast-out, gentle settle */
  --t-fast: 150ms; --t-med: 300ms;
}
@media (prefers-color-scheme: dark) {
  :root { --paper: #161616; --paper-warm: #191a16; --surface: #202020;
          --ink: #f2f2f2; --ink-2: #d0d0d0; --ink-3: rgba(220,220,220,.5);
          --hairline: rgba(255,255,255,.12); --hairline-2: rgba(255,255,255,.06); }
  /* lime stays lime — it reads even better on dark */
}
```

Fonts are to be bundled locally (extension CSP forbids remote fonts): Manrope + IBM Plex Mono +
Instrument Serif, variable/woff2, in `sidepanel/fonts/`. All are OFL-licensed. (Not yet in the
repo — the current stylesheet uses the system font stack.)

## Type scale (side-panel sized)

| Role | Face | Size/weight | Notes |
|---|---|---|---|
| Display (empty states, onboarding hello) | sans | 28px / 400, letter-spacing -0.03em, line-height 0.98 | Big type at REGULAR weight, tight tracking — the signature. Two-tone: lead words `--ink-3`, payoff words `--ink` |
| Serif accent | serif | inherit size, italic | One or two words inside a display line ("filled *truthfully*") |
| H2 / card title | sans | 17px / 500 | |
| Body | sans | 13.5px / 400, line-height 1.5 | |
| Eyebrow / microcopy | mono | 11px / 500, UPPERCASE, letter-spacing .04em, color `--ink-3` | Section labels: RUN, PROFILE, HISTORY. Status lines. Timestamps |
| Stat numeral | sans | 32px / 400, tight | e.g. applications sent counter |

## Components

- **Nav**: floating pill bar, `--paper-warm` bg, 1px `--hairline`, radius 999px, centered tabs;
  active tab = ink text + a 4px lime dot; inactive = `--ink-3`.
- **Buttons**: primary = lime bg, ink text, radius `--r-s`, 8px×14px padding, no shadow;
  hover: translateY(-1px) + brightness(1.02); active: translateY(0). Secondary = paper bg +
  hairline border. Destructive = ink bg, paper text. Never blue, never gradients.
- **Sparkle chip**: primary CTAs may carry a leading 20px rounded-square lime chip with an ink
  four-point sparkle (✦) — the LarpMaxer mark. Also the loader (spinning ✦ in lime).
- **Bento cards**: default `--paper` + 1px hairline, radius `--r-m`, 16px padding. Rhythm cards:
  at most ONE lime card and one-two ink cards visible per screen. Card anatomy: top-left
  **dot-matrix glyph**, bottom-left title. Glyphs are 3×3 dot-grid patterns drawn in CSS/SVG
  (distinct pattern per section: Run, Profile, History, Settings).
- **Review artifact** (the product's hero moment): ink card, paper text; each field row
  `label (mono, --ink-3)` → `value (sans, paper)`; hairline row separators at 8% white; footer:
  lime **Approve & Submit** + ghost **Cancel**. It should feel like signing something.
- **"Your turn" card — login prompt** (first-class flow, not an error): paper-warm card,
  lime left border (3px), sparkle chip; mono eyebrow `YOUR TURN`; body: "Log in to
  **seek.com.au** in this tab, then continue." One lime button: **I've logged in — continue**;
  ghost link: "Skip this site". Same pattern for CAPTCHA ("Solve the puzzle, then continue")
  and per-employer accounts (Workday). Never blame the user; the copy is calm and specific.
- **Status/phase badges**: mono 11px uppercase in a hairline pill; submitted = lime pill w/ ink text.
- **Empty states**: two-tone display line + one primary action. E.g. "Nothing sent *yet.*"
- **Elevation** (revised 2026-08-28): surfaces are physical. Three tokens model one light
  source above the panel: `--lift-1` (buttons, resting), `--lift-2` (cards, nav), `--lift-3`
  (the two cards that demand attention: "your turn" and the review artifact). Each pairs a
  tight contact shadow with a wider diffuse falloff, plus `--edge-top` — a 1px inset white
  highlight that reads as light catching the top bevel.
- **Raised vs recessed carries meaning.** Things you act *on* rise (cards, buttons); things you
  type *into* are carved in (`--edge-inset` on inputs and repeater wells). Pressing a button
  swaps its lift for the inset, so it physically sinks. Never decorate with depth that has no
  meaning — a shadow is a claim about what the object is.
- **Dark mode re-derives, never reuses.** Shadows on dark ground are near-black and the lit edge
  drops to a 7% white rim; the same tokens, different values.

## Motion

- Panel/tab transitions: 300ms fade+4px rise, `--ease`. List items stagger 30ms.
- Hover on nav/labels: text-roll (duplicate label slides up) — the mapo hover; implement with a
  two-span wrapper, translateY.
- The loader: lime ✦ rotating with a springy step (0→90° with overshoot), on `--paper`.
- Filling progress: fields tick from `--ink-3` to ink with a 150ms lime flash on completion.
- Respect `prefers-reduced-motion`: all transforms off, opacity only.

## Voice

Plain, confident, zero fluff (mapo: "No guesswork on pricing"). Examples:
"Fillable: Greenhouse" / "3 answers need you" / "Sent. Next." Microcopy in mono, sentences in sans.

## Rules

1. Lime is a scalpel, not a paint bucket: primary action, success, one rhythm card, the sparkle. Never body text, never borders-everywhere.
2. Weight discipline: 400 for display and body, 500 for titles/buttons. Nothing bolder.
3. No blue links, no default focus rings — focus = 2px lime outline offset 2px (a11y-visible).
4. Density: the side panel is narrow (~360px). One column, generous vertical air, no two-column cramming.
5. Every screen has exactly one lime element competing for the eye.
