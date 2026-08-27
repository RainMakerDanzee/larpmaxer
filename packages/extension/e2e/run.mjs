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
// A host no adapter matches, for the classified-page scenario.
const UNKNOWN_HOST = "careers.northwind.example";
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
    "-addext", `subjectAltName=DNS:${HOST},DNS:${UNKNOWN_HOST}`,
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
  manifest.host_permissions = [
    ...(manifest.host_permissions ?? []),
    `${ORIGIN}/*`,
    `https://${UNKNOWN_HOST}:${PORT}/*`,
  ];
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

/**
 * Install a stand-in for Chrome's on-device model in the service worker.
 *
 * The real Gemini Nano weights cannot be downloaded in CI, and the point of
 * this scenario is the pipeline around the model, not the model. The stub
 * answers by PARSING THE PROMPT it is given — so if the prompt format ever
 * stops naming controls the way classify.ts intends, this test fails rather
 * than passing on a hardcoded answer.
 */
async function installStubModel(sw) {
  await sw.evaluate(() => {
    globalThis.LanguageModel = {
      availability: async () => "available",
      create: async () => ({
        prompt: async (input) => {
          // Answer prompts (one field at a time) are not this stub's job.
          if (!input.includes("Form controls:")) return "UNKNOWN";
          const controls = [...input.matchAll(/^(\d+)\. \[(\w+)\] (.*)$/gm)].map((m) => ({
            index: Number(m[1]),
            kind: m[2],
            text: m[3],
          }));
          const buttons = [...input.matchAll(/^(\d+)\. "(.*)"$/gm)].map((m) => ({
            index: Number(m[1]),
            text: m[2],
          }));
          const isJobAlert = (t) => /subscribe|alert|newsletter/i.test(t);
          const fields = controls
            .filter((c) => !isJobAlert(c.text))
            .map((c) => ({ index: c.index, meaning: meaningOf(c.text) }));
          const submit = buttons.find((b) => /send|submit|apply/i.test(b.text));
          return JSON.stringify({
            isApplicationForm: fields.length > 0,
            fields,
            ...(submit ? { submitIndex: submit.index } : {}),
          });

          function meaningOf(text) {
            const t = text.toLowerCase();
            if (t.includes("name")) return "full_name";
            if (t.includes("email")) return "email";
            if (t.includes("phone")) return "phone";
            if (t.includes("cv") || t.includes("resume")) return "resume";
            if (t.includes("sponsor")) return "sponsorship";
            return "other";
          }
        },
        destroy() {},
      }),
    };
  });
}

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
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP ${UNKNOWN_HOST} 127.0.0.1`,
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
        const blocked = (await seen("HUMAN_NEEDED")).slice(-1)[0];
        throw new Error(
          `${err.message}. Last run state: ${last ? JSON.stringify(last.record) : "none"}` +
            (blocked ? `. Handed back: ${blocked.reason} — ${blocked.detail}` : ""),
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

    // --- a page with no evidence of an application ------------------
    // The first step of a multi-step form shows a couple of name fields and a
    // Next button: no email, no submit, no resume field. The generic adapter
    // must refuse it rather than claim it, for the same reason it refuses a
    // job-board search page. Next-button pagination is exactly what search
    // results have too, which is why multi-step support is opt-in per adapter
    // (quirks.paginated) and not inferred from the page.
    await job.goto(`${ORIGIN}/paginated.html`, { waitUntil: "domcontentloaded" });
    await panel.evaluate(() => {
      window.__seen = [];
    });
    await send({ type: "DETECT_REQUEST", tabId });
    await await1("DETECT_RESULT");
    const handoff = (await seen("HUMAN_NEEDED"))[0];
    check(
      "hands back a page with no evidence of an application, rather than filling it",
      handoff?.reason === "unknown_page",
      JSON.stringify(handoff ?? null),
    );
    check("and never claimed to have filled it", (await seen("PLAN_READY")).length === 0);

    // --- a site no adapter has ever seen ---------------------------------
    // The whole point of the classified path: an unknown ATS on an unknown
    // host, filled because a model read the survey — not because anyone wrote
    // an adapter for it.
    // This scenario is the one that needs a model: turn it on, and stand a
    // stub in for the on-device one, whose weights cannot be fetched in CI.
    await panel.evaluate(async () => {
      await chrome.storage.local.set({
        settings: {
          autonomy: "review",
          saveArtifacts: false,
          autoRegister: false,
          llm: { provider: "chrome", apiKey: "", model: "" },
        },
      });
    });
    await installStubModel(sw);
    await job.goto(`https://${UNKNOWN_HOST}:${PORT}/unknown-ats.html`, {
      waitUntil: "domcontentloaded",
    });
    await panel.evaluate(() => {
      window.__seen = [];
    });
    await send({ type: "DETECT_REQUEST", tabId });

    const uDetect = await await1("DETECT_RESULT");
    check(
      "no ATS-specific adapter recognises the unknown site",
      uDetect.adapterId === "universal" || uDetect.adapterId === "generic",
      String(uDetect.adapterId),
    );

    const uPlan = await await1("PLAN_READY");
    const uAnswers = new Map(uPlan.plan.answers.map((a) => [a.fieldId, a.value]));
    check("the model's field choices became a plan", uAnswers.size > 0, JSON.stringify([...uAnswers]));
    check(
      "the plan carries its own field model, having no adapter to re-discover through",
      Array.isArray(uPlan.plan.fields) && uPlan.plan.fields.length > 0,
    );
    check(
      "the submit control came from the page's own buttons",
      uPlan.plan.submitSelector === "#nw-go",
      String(uPlan.plan.submitSelector),
    );
    check(
      "the site search box was never treated as a question",
      !JSON.stringify(uPlan.plan.fields).includes("nw-find"),
    );
    check(
      "the newsletter signup was not mistaken for the application",
      !JSON.stringify(uPlan.plan.fields).includes("nw-news"),
    );

    await send({ type: "EXECUTE_PLAN", tabId, plan: uPlan.plan });
    await await1("FILL_REPORT");
    const uPage = await job.evaluate(() => ({
      name: document.getElementById("nw-a1").value,
      email: document.getElementById("nw-a2").value,
      phone: document.getElementById("nw-a3").value,
      cv: document.getElementById("nw-a4").files[0]?.name ?? null,
      submitted: /thank you for applying/i.test(document.body.innerText),
    }));
    check("filled a form no adapter knows: name", uPage.name === "Riley Park", uPage.name);
    check("filled a form no adapter knows: email", uPage.email === PROFILE.email, uPage.email);
    check("attached the resume on an unknown site", uPage.cv === "riley-park-cv.txt", String(uPage.cv));
    check("did not submit before being told to", uPage.submitted === false);

    await send({ type: "APPROVE_SUBMIT", tabId });
    const uSubmit = await await1("SUBMIT_RESULT");
    check("submitted on a site nobody wrote an adapter for", uSubmit.result.submitted === true, JSON.stringify(uSubmit.result.evidence));

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
