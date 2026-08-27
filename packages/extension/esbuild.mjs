// Build for @larpmaxer/extension. Bundles the three entry points, copies the
// static assets, and writes placeholder icons. dist/ mirrors the layout that
// manifest.json references:
//   manifest.json            (copied from the package root)
//   background/index.js      (esm — service worker with "type": "module")
//   content/index.js         (iife — injected via chrome.scripting)
//   sidepanel/index.html + sidepanel/main.js + sidepanel/styles.css
//   icons/icon{16,48,128}.png
// Usage: node esbuild.mjs [--watch]
import * as esbuild from "esbuild";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(fileURLToPath(import.meta.url));
const dist = join(pkgDir, "dist");
const watch = process.argv.includes("--watch");

/** First candidate (relative to the package dir) that exists, else null. */
function first(candidates) {
  for (const c of candidates) {
    const abs = join(pkgDir, c);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** Like first(), but a hard build error when nothing exists. */
function must(label, candidates) {
  const found = first(candidates);
  if (!found) {
    console.error(`esbuild.mjs: missing ${label} — looked for ${candidates.join(", ")}`);
    process.exit(1);
  }
  return found;
}

// src/-nested is the canonical layout; flat fallbacks keep forks working.
const bundles = [
  {
    label: "background entry",
    entry: ["src/background/index.ts", "background/index.ts"],
    outfile: "background/index.js",
    format: "esm",
  },
  {
    label: "content entry",
    entry: ["src/content/index.ts", "content/index.ts"],
    outfile: "content/index.js",
    format: "iife", // injected scripts execute as classic scripts, not modules
  },
  {
    label: "sidepanel entry",
    entry: ["src/sidepanel/main.tsx", "sidepanel/main.tsx"],
    outfile: "sidepanel/main.js",
    format: "esm", // loaded via <script type="module"> in sidepanel/index.html
  },
];

const statics = [
  {
    label: "manifest.json",
    candidates: ["manifest.json", "src/manifest.json"],
    out: "manifest.json",
    required: true,
  },
  {
    label: "side panel HTML",
    candidates: ["src/sidepanel/index.html", "sidepanel/index.html"],
    out: join("sidepanel", "index.html"),
    required: true,
  },
  {
    label: "stylesheet",
    candidates: ["src/sidepanel/styles.css", "sidepanel/styles.css", "styles.css"],
    out: join("sidepanel", "styles.css"),
    required: false,
  },
  {
    label: "design preview page",
    candidates: ["src/sidepanel/preview.html", "sidepanel/preview.html"],
    out: join("sidepanel", "preview.html"),
    required: false,
  },
  // Demo harness: runs the real panel UI in an ordinary browser tab.
  {
    label: "demo page",
    candidates: ["src/sidepanel/demo.html"],
    out: join("sidepanel", "demo.html"),
    required: false,
  },
  {
    label: "demo shim",
    candidates: ["src/sidepanel/demo-shim.js"],
    out: join("sidepanel", "demo-shim.js"),
    required: false,
  },
];

// Bundled font files (see styles.css @font-face) — copied as a directory.
const fontsSrc = first(["src/sidepanel/fonts", "sidepanel/fonts"]);

// Clear dist's CONTENTS, never dist itself: on Windows the directory handle is
// held open whenever Chrome has the unpacked extension loaded, and removing the
// root fails with EPERM — which would break the build/reload loop contributors
// actually use. Emptying in place keeps that loop working.
if (existsSync(dist)) {
  for (const entry of readdirSync(dist)) {
    rmSync(join(dist, entry), { recursive: true, force: true });
  }
}
mkdirSync(join(dist, "icons"), { recursive: true });

for (const s of statics) {
  const src = s.required ? must(s.label, s.candidates) : first(s.candidates);
  if (!src) {
    console.warn(`esbuild.mjs: no ${s.label} found (${s.candidates.join(", ")}) — skipped`);
    continue;
  }
  const out = join(dist, s.out);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(src, out);
}

if (fontsSrc) cpSync(fontsSrc, join(dist, "sidepanel", "fonts"), { recursive: true });

// Real icons, rendered from icons/icon.svg by `npm run icons` and committed,
// so a build needs no image tooling and no browser.
for (const size of [16, 48, 128]) {
  const name = `icon${size}.png`;
  const src = join(pkgDir, "icons", name);
  if (!existsSync(src)) {
    throw new Error(`larpmaxer build: missing icons/${name} — run \`npm run icons\``);
  }
  copyFileSync(src, join(dist, "icons", name));
}

/** @type {import("esbuild").BuildOptions[]} */
const configs = bundles.map((b) => ({
  entryPoints: [must(b.label, b.entry)],
  outfile: join(dist, b.outfile),
  format: b.format,
  bundle: true,
  sourcemap: true,
  minify: false,
  target: ["chrome114"], // keep in sync with manifest minimum_chrome_version
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "info",
}));

try {
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("watching bundles… (static assets are copied once — restart after editing them)");
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    console.log(`built ${dist}`);
  }
} catch {
  // esbuild already printed the errors (logLevel: "info"); skip the stack.
  process.exit(1);
}
