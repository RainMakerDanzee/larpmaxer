/**
 * End-to-end run through the real extension.
 *
 * Everything else in this repo tests the engine in Node. This drives the
 * product: an unpacked MV3 build loaded into Chromium, its service worker, its
 * content script, and its message protocol, against a page served over HTTP.
 * The fill and submit path had never been exercised this way — only by hand —
 * so a regression in the wiring between the three surfaces could not be caught
 * by any test.
 *
 * It deliberately talks to the extension the way the side panel does: it opens
 * the panel page and sends the same messages, rather than reaching into module
 * internals. If this passes, the protocol works.
 *
 *   node packages/extension/e2e/run.mjs        (after npm run build)
 *
 * Exits non-zero on the first failed check.
 */

import { chromium } from "playwright";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const FIXTURES = join(HERE, "fixtures");
const PORT = 8931;
// https, not http: LarpMaxer refuses to run on plain http, and a test that
// worked around that would stop exercising the real entry conditions.
const HOST = "boards.greenhouse.io";
const ORIGIN = `https://${HOST}:${PORT}`;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// --- tiny check harness -----------------------------------------------------

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok || detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

/** Poll until `fn` returns truthy, or throw after `ms`. */
async function until(label, fn, ms = 15000, every = 200) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// --- fixture server ---------------------------------------------------------

/** A throwaway self-signed cert, so the fixture can be served over https. */
function selfSignedCert(dir) {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert,
    "-subj", `/CN=${HOST}`,
    "-addext", `subjectAltName=DNS:${HOST}`,
  ], { stdio: "ignore" });
  return { key, cert };
}

function serve(tls) {
  const server = createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
    const name = (req.url ?? "/").split("?")[0].replace(/^\/+/, "") || "greenhouse.html";
    try {
      const body = await readFile(join(FIXTURES, name));
      res.writeHead(200, { "content-type": MIME[extname(name)] ?? "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

/**
 * Copy the build and grant it the fixture origin.
 *
 * The shipped manifest asks for ATS origins at runtime, per-site, on the
 * user's say-so — which is a consent flow, not something this test is about.
 * Patching a throwaway copy keeps that flow honest in the real manifest.
 */
async function buildTestExtension() {
  const dir = await mkdtemp(join(tmpdir(), "larpmaxer-e2e-"));
  await cp(DIST, dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [...(manifest.host_permissions ?? []), `${ORIGIN}/*`];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

// --- the profile the run fills from ----------------------------------------

const PROFILE = {
  name: "Riley Park",
  email: "riley.park@example.com",
  phone: "+61400000000",
  location: "Sydney, NSW, Australia",
  links: [{ label: "LinkedIn", url: "https://linkedin.com/in/rileypark" }],
  workRights: "Australian permanent resident",
  needsSponsorship: false,
  noticePeriod: "4 weeks",
  salary: "A$120,000",
  summary: "Data analyst who automates the boring parts.",
  skills: ["Python", "SQL"],
  experience: [
    {
      title: "Senior Data Analyst",
      company: "Acme Pty Ltd",
      start: "2022-03",
      end: "present",
      highlights: ["Rebuilt the weekly reporting pipeline."],
    },
  ],
  education: [{ institution: "Macquarie University", qualification: "BIT", year: "2018" }],
  // Approved answers cover the two free-text questions, so the run needs no
  // model and no network: this test is about the wiring, not about answering.
  qaBank: [
    { question: "Why do you want to work here?", answer: "Acme builds infrastructure I admire.", approved: true, uses: 0 },
    { question: "How did you hear about us?", answer: "LinkedIn", approved: true, uses: 0 },
    { question: "Which locations are you open to?", answer: "Sydney", approved: true, uses: 0 },
  ],
  resumes: [{ id: "resume-1", filename: "riley-park-cv.txt", mime: "text/plain" }],
};

async function main() {
  const certDir = await mkdtemp(join(tmpdir(), "larpmaxer-tls-"));
  const paths = selfSignedCert(certDir);
  const server = await serve({
    key: await readFile(paths.key),
    cert: await readFile(paths.cert),
  });
  const extDir = await buildTestExtension();
  const userDir = await mkdtemp(join(tmpdir(), "larpmaxer-profile-"));

  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    channel: "chromium",
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--no-sandbox",
      "--ignore-certificate-errors",
      // Point the real ATS hostname at the local fixture server.
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
      // Everything in this test is local; a configured proxy would otherwise
      // intercept the mapped hostname and break the connection.
      "--no-proxy-server",
    ],
  });

  try {
    const sw =
      ctx.serviceWorkers()[0] ??
      (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
    const extId = new URL(sw.url()).host;
    check("service worker registered", Boolean(extId), sw.url());
    if (process.env.E2E_DEBUG) {
      ctx.on("console", (m) => console.log("  [console]", m.type(), m.text()));
      ctx.on("weberror", (e) => console.log("  [weberror]", String(e.error())));
      sw.on("console", (m) => console.log("  [sw]", m.type(), m.text()));
    }

    // The posting, and the panel that drives it.
    const job = await ctx.newPage();
    await job.goto(`${ORIGIN}/greenhouse.html`, { waitUntil: "domcontentloaded" });

    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel/index.html`, {
      waitUntil: "domcontentloaded",
    });

    // Seed storage exactly as the panel would have. It happens from the panel
    // page rather than the worker because chrome.storage is not reachable from
    // the worker's evaluation context under CDP.
    await panel.evaluate(
      async ([profile, resumeB64]) => {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({
          profile,
          settings: { autonomy: "review", saveArtifacts: false, autoRegister: false, llmOff: true },
          "resume:resume-1": resumeB64,
        });
      },
      [PROFILE, Buffer.from("Riley Park - CV\nSenior Data Analyst.").toString("base64")],
    );

    // Collect every broadcast the panel receives, so the run can be followed.
    await panel.evaluate(() => {
      window.__seen = [];
      chrome.runtime.onMessage.addListener((m) => {
        window.__seen.push(m);
      });
    });

    const tabId = await panel.evaluate(async (origin) => {
      const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
      return tab?.id ?? -1;
    }, ORIGIN);
    check("found the job tab", tabId > 0, `tabId=${tabId}`);

    const send = (msg) => panel.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const seen = (type) =>
      panel.evaluate((t) => window.__seen.filter((m) => m.type === t), type);
    /** Wait for one message type, reporting the run's own state if it never comes. */
    const await1 = async (type, ms = 20000) => {
      try {
        return await until(type, async () => (await seen(type))[0], ms);
      } catch (err) {
        const states = await seen("RUN_STATE");
        const last = states[states.length - 1];
        throw new Error(
          `${err.message}. Last run state: ${last ? JSON.stringify(last.record) : "none"}`,
        );
      }
    };

    // --- detect ----------------------------------------------------------
    await send({ type: "DETECT_REQUEST", tabId });
    const detect = await await1("DETECT_RESULT");
    check("detected the greenhouse adapter", detect.adapterId === "greenhouse", detect.adapterId);

    // --- discover + resolve ----------------------------------------------
    const plan = await await1("PLAN_READY");
    const answered = new Map(plan.plan.answers.map((a) => [a.fieldId, a.value]));
    check("resolved the applicant's name", answered.get("first_name") === "Riley", answered.get("first_name"));
    check("resolved the email", answered.get("email") === PROFILE.email, answered.get("email"));
    check("attached the resume", answered.get("resume") === "riley-park-cv.txt", answered.get("resume"));
    check(
      "answered the screening question from the Q&A bank",
      (answered.get("question_100") ?? "").includes("Acme"),
      answered.get("question_100"),
    );

    // --- fill -------------------------------------------------------------
    await send({ type: "EXECUTE_PLAN", tabId, plan: plan.plan });
    const report = await await1("FILL_REPORT");
    const bad = report.report.fields.filter(
      (f) => f.outcome !== "verified" && f.outcome !== "filled",
    );
    check("every field filled and verified", bad.length === 0, JSON.stringify(bad));
    check("the report calls the fill complete", report.report.complete === true);
    check(
      "every field was read back from the DOM, not just typed",
      report.report.fields.every((f) => f.outcome === "verified"),
      report.report.fields.map((f) => `${f.fieldId}:${f.outcome}`).join(" "),
    );

    // Read the page itself — the report says it typed, this proves it stuck.
    const onPage = await job.evaluate(() => ({
      first: document.getElementById("first_name").value,
      last: document.getElementById("last_name").value,
      email: document.getElementById("email").value,
      phone: document.getElementById("phone").value,
      why: document.getElementById("question_100").value,
      heard: document.getElementById("question_101").value,
      sydney: document.getElementById("question_102_0").checked,
      resume: document.getElementById("resume").files[0]?.name ?? null,
    }));
    check("first name typed into the page", onPage.first === "Riley", onPage.first);
    check("last name typed into the page", onPage.last === "Park", onPage.last);
    check("email typed into the page", onPage.email === PROFILE.email, onPage.email);
    check("select resolved to an option value", onPage.heard === "9001", onPage.heard);
    check("checkbox ticked", onPage.sydney === true, String(onPage.sydney));
    check("resume attached without an OS dialog", onPage.resume === "riley-park-cv.txt", onPage.resume);

    // --- submit -----------------------------------------------------------
    await send({ type: "APPROVE_SUBMIT", tabId });
    const submit = await await1("SUBMIT_RESULT");
    check("submitted", submit.result.submitted === true, JSON.stringify(submit.result.evidence));
    check(
      "verified the ATS success message",
      (submit.result.evidence ?? []).some((e) => /thank you for applying/i.test(e)),
      JSON.stringify(submit.result.evidence),
    );

    const confirmed = await job.evaluate(() => document.body.innerText);
    check("page really shows the confirmation", /application has been received/i.test(confirmed));

    // --- the run was recorded --------------------------------------------
    const records = await panel.evaluate(
      async () => (await chrome.storage.local.get("records")).records ?? [],
    );
    check("the application was recorded in history", records.length === 1, `${records.length} record(s)`);
  } finally {
    await ctx.close();
    server.close();
  }

  console.log(failures === 0 ? "\nE2E: all checks passed" : `\nE2E: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nE2E harness error:", err);
  process.exit(1);
});
