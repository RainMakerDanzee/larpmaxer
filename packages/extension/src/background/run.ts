/**
 * Per-tab run state machine (core `RunPhase`). One application, end to end:
 *
 *   DETECT_REQUEST ─ ensure host permission + content script (login ping)
 *     → detecting    DETECT_REQUEST to tab    → DETECT_RESULT
 *     → discovering  DISCOVER_REQUEST to tab  → DISCOVER_RESULT
 *     → resolving    core resolveAnswers (+ LLM delegate if configured)
 *     → PLAN_READY   needsUser? awaiting_user : review
 *                    ("auto" autonomy skips the plan review, straight to filling)
 *     → filling      EXECUTE_PLAN to tab      → FILL_REPORT
 *     → review       ("auto" skips this gate too, iff the report is complete)
 *     → submitting   APPROVE_SUBMIT to tab    → SUBMIT_RESULT
 *     → done | error   (a blocked submit returns to review for a retry)
 *
 * Run state is in-memory per tabId; the persisted ApplicationRecord is
 * upserted at fill/submit/error milestones. An MV3 service-worker restart
 * drops in-flight runs — the user simply re-triggers detect from the panel
 * (EXECUTE_PLAN also rebuilds a run from its own payload).
 */

import type {
  AnswerDelegate,
  ApplicationRecord,
  FillPlan,
  Message,
  ResolvedAnswer,
} from "@larpmaxer/core";
import {
  createProvider,
  makeLlmDelegate,
  mergeQaEntry,
  recordOpenQuestions,
  resolveAnswers,
} from "@larpmaxer/core";
import { pingTab, sendToRuntime, sendToTab, type Pong } from "../lib/messaging.js";
import {
  addRecord,
  generatePassword,
  getCredential,
  getProfile,
  getResumeBase64,
  getSettings,
  putCredential,
  setProfile,
} from "./storage.js";
import { noteDetect, noteRunPhase } from "./queue.js";
import { saveApplicationArtifacts } from "./artifacts.js";

/** Narrowed member of the core Message union. */
type Msg<T extends Message["type"]> = Extract<Message, { type: T }>;

/** In-flight run for one tab. */
interface Run {
  tabId: number;
  record: ApplicationRecord;
  plan?: FillPlan;
  /** One credential attempt per run — prevents login/registration loops. */
  authAttempted?: boolean;
}

const runs = new Map<number, Run>();

/** Bundled content-script entry, injected on demand — never in the manifest. */
const CONTENT_SCRIPT = "content/index.js";

/**
 * Entry point — DETECT_REQUEST from the side panel starts (or restarts) a run.
 * Grants/checks host permission, injects the content script if the ping goes
 * unanswered, and pauses with HUMAN_NEEDED when the page looks like a login.
 */
export async function startRun(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const url = tab?.url;
  const run: Run = {
    tabId,
    record: {
      id: crypto.randomUUID(),
      url: url ?? "",
      adapterId: "", // unknown until DETECT_RESULT
      phase: "detecting",
    },
  };
  runs.set(tabId, run);

  if (url === undefined) {
    // Without activeTab or a host grant Chrome hides the URL from us.
    await humanNeeded(
      run,
      "unknown_page",
      "Cannot read this tab. Open the job page, then start LarpMaxer from its toolbar button.",
    );
    return;
  }
  if (!url.startsWith("https://")) {
    await humanNeeded(run, "unknown_page", "LarpMaxer only runs on https:// pages.");
    return;
  }

  await emitState(run);
  await step(run, async () => {
    await ensureHostPermission(url);
    const pong = await ensureContentScript(tabId);
    if (pong.hasPasswordField) {
      await handleAuthWall(run, url);
      return;
    }
    await sendToTab(tabId, { type: "DETECT_REQUEST", tabId });
  });
}

/** Content answered detect: record the adapter, or hand the page to the human. */
export async function handleDetectResult(msg: Msg<"DETECT_RESULT">): Promise<void> {
  const run = runs.get(msg.tabId);
  if (!run) return;
  if (msg.adapterId === null) {
    await noteDetect(msg.tabId, null).catch(() => undefined);
    await humanNeeded(run, "unknown_page", "No adapter recognises this page — apply manually.");
    return;
  }
  run.record.adapterId = msg.adapterId;
  run.record.jobTitle = msg.jobTitle;
  await sendToRuntime(msg); // panel shows "Fillable: <adapter>"
  await noteDetect(msg.tabId, msg.adapterId, msg.jobTitle).catch(() => undefined);
  await step(run, async () => {
    run.record.phase = "discovering";
    await emitState(run);
    await sendToTab(run.tabId, { type: "DISCOVER_REQUEST", tabId: run.tabId });
  });
}

/** Panel asked to (re-)discover; with no run on the tab this starts one. */
export async function handleDiscoverRequest(msg: Msg<"DISCOVER_REQUEST">): Promise<void> {
  const run = runs.get(msg.tabId);
  if (!run) {
    await startRun(msg.tabId);
    return;
  }
  await step(run, async () => {
    run.record.phase = "discovering";
    await emitState(run);
    await ensureContentScript(msg.tabId); // page may have navigated since
    await sendToTab(msg.tabId, msg);
  });
}

/** Fields found: resolve answers from profile → Q&A bank → LLM, then PLAN_READY. */
export async function handleDiscoverResult(msg: Msg<"DISCOVER_RESULT">): Promise<void> {
  const run = runs.get(msg.tabId);
  if (!run) return;
  await step(run, async () => {
    run.record.phase = "resolving";
    await emitState(run);
    const profile = await getProfile();
    if (profile === undefined) {
      await fail(run, "no profile yet — fill in your profile in the side panel first");
      return;
    }
    const llm = await llmDelegate();
    const resolved = await resolveAnswers(msg.fields, profile, llm);
    // Every question this form asked and we could not answer joins the bank
    // unanswered, so the user can fill it in later instead of meeting it again
    // on the next posting. Additive: an existing answer is never touched.
    if (resolved.needsUser.length > 0) {
      await setProfile(
        recordOpenQuestions(
          profile,
          resolved.needsUser.map((q) => q.label),
        ),
      );
    }
    run.plan = {
      adapterId: run.record.adapterId,
      url: run.record.url,
      jobTitle: run.record.jobTitle,
      company: run.record.company,
      answers: resolved.answers,
      needsUser: resolved.needsUser,
    };
    await planReady(run);
  });
}

/** Panel answered one intake question: update the plan, optionally grow the Q&A bank. */
export async function handleIntakeAnswer(msg: Msg<"INTAKE_ANSWER">): Promise<void> {
  // INTAKE_ANSWER carries no tabId — locate the run waiting on this field.
  const run = [...runs.values()].find((r) =>
    r.plan?.needsUser.some((q) => q.fieldId === msg.fieldId),
  );
  const plan = run?.plan;
  if (run === undefined || plan === undefined) return;
  const question = plan.needsUser.find((q) => q.fieldId === msg.fieldId);
  if (question === undefined) return;
  await step(run, async () => {
    plan.needsUser = plan.needsUser.filter((q) => q.fieldId !== msg.fieldId);
    plan.answers = [
      ...plan.answers.filter((a) => a.fieldId !== msg.fieldId),
      { fieldId: msg.fieldId, value: msg.value, source: "user" },
    ];
    if (msg.saveToQaBank) {
      const profile = await getProfile();
      if (profile !== undefined) {
        // mergeQaEntry, not a push: the question is already in the bank as an
        // unanswered placeholder, and a push would leave a duplicate behind.
        // approved: true — the user just authored this exact wording.
        await setProfile(
          mergeQaEntry(profile, {
            question: question.label,
            answer: msg.value,
            approved: true,
            uses: 0,
          }),
        );
      }
    }
    await planReady(run); // re-broadcasts; auto mode executes once the queue empties
  });
}

/**
 * Fill the page. Reached from the panel's approval, or internally from
 * planReady() when settings.autonomy === "auto". The message's plan is
 * authoritative — the panel may have edited values during review.
 */
export async function handleExecutePlan(msg: Msg<"EXECUTE_PLAN">): Promise<void> {
  const run: Run = runs.get(msg.tabId) ?? {
    // Service worker restarted since the plan was made; rebuild from the payload.
    tabId: msg.tabId,
    record: {
      id: crypto.randomUUID(),
      url: msg.plan.url,
      company: msg.plan.company,
      jobTitle: msg.plan.jobTitle,
      adapterId: msg.plan.adapterId,
      phase: "idle",
    },
  };
  runs.set(msg.tabId, run);
  if (msg.plan.needsUser.length > 0) {
    // Core rule: a plan is not executable while needsUser is non-empty.
    console.warn("[larpmaxer] refusing EXECUTE_PLAN: plan has unanswered questions");
    run.record.phase = "awaiting_user";
    await emitState(run);
    return;
  }
  run.plan = msg.plan;
  // Keep the byte-free plan (resume answers = filenames) for review + artifacts.
  run.record.plan = msg.plan;
  await step(run, async () => {
    run.record.phase = "filling";
    await emitState(run);
    await ensureContentScript(msg.tabId); // tab may have reloaded since discover
    // Content decodes file answers from base64 in `value` (ResumeRef is
    // metadata only), so swap the plan's filenames for stored bytes here.
    const plan = { ...msg.plan, answers: await withResumePayloads(msg.plan.answers) };
    await sendToTab(msg.tabId, { ...msg, plan });
  });
}

/** Replace each file answer's value with its resume's base64 bytes from storage. */
async function withResumePayloads(answers: ResolvedAnswer[]): Promise<ResolvedAnswer[]> {
  return Promise.all(
    answers.map(async (a) => {
      if (a.resume === undefined) return a;
      const b64 = await getResumeBase64(a.resume.id);
      if (b64 === undefined) throw new Error(`resume "${a.resume.filename}" has no stored bytes`);
      return { ...a, value: b64 };
    }),
  );
}

/** Content finished filling: persist the report, then review-gate or auto-submit. */
export async function handleFillReport(msg: Msg<"FILL_REPORT">): Promise<void> {
  const run = runs.get(msg.tabId);
  if (!run) return;
  await step(run, async () => {
    run.record.report = msg.report;
    await sendToRuntime(msg); // panel renders the filled-form artifact
    const { autonomy } = await getSettings();
    if (autonomy === "auto" && msg.report.complete) {
      await handleApproveSubmit({ type: "APPROVE_SUBMIT", tabId: msg.tabId });
      return;
    }
    // Review gate — also for auto runs whose fill came back incomplete.
    run.record.phase = "review";
    await addRecord(run.record);
    await emitState(run);
  });
}

/** Submit gate cleared (user click, or auto mode): have content press submit. */
export async function handleApproveSubmit(msg: Msg<"APPROVE_SUBMIT">): Promise<void> {
  const run = runs.get(msg.tabId);
  if (!run) {
    // No in-memory run (worker restart). Best effort: content keeps its own plan.
    await sendToTab(msg.tabId, msg).catch((err) => console.warn(`[larpmaxer] ${String(err)}`));
    return;
  }
  await step(run, async () => {
    run.record.phase = "submitting";
    await addRecord(run.record);
    await emitState(run);
    await sendToTab(msg.tabId, msg);
  });
}

/** Content watched the page after submit: close out (or bounce back to review). */
export async function handleSubmitResult(msg: Msg<"SUBMIT_RESULT">): Promise<void> {
  const run = runs.get(msg.tabId);
  if (!run) return;
  await step(run, async () => {
    run.record.submit = msg.result;
    if (msg.result.submitted) {
      run.record.submittedAt = new Date().toISOString();
      run.record.phase = "done";
      runs.delete(msg.tabId);
      await saveApplicationArtifacts(run.record); // never throws
    } else {
      // Validation blocked it; evidence sits in record.submit. User may retry.
      run.record.phase = "review";
    }
    await addRecord(run.record);
    await sendToRuntime(msg);
    await emitState(run);
  });
}

/**
 * A password field gates the page. Consent-once model (docs/registration.md):
 * stored credential → log in autonomously; none → offer to create the account;
 * declined/failed → classic manual "your turn".
 */
async function handleAuthWall(run: Run, url: string): Promise<void> {
  const origin = new URL(url).origin;
  if (run.authAttempted === true) {
    await humanNeeded(run, "login", `Automatic sign-in at ${origin} did not stick — take it from here, then scan again.`);
    return;
  }
  const cred = await getCredential(origin);
  const profile = await getProfile();
  if (cred !== undefined && profile !== undefined) {
    run.authAttempted = true;
    run.record.phase = "registering";
    await emitState(run);
    await sendToTab(run.tabId, {
      type: "REGISTER_FILL",
      tabId: run.tabId,
      origin,
      mode: "login",
      email: cred.email,
      password: cred.password,
    });
    return;
  }
  const { autoRegister } = await getSettings();
  if (autoRegister !== false && profile !== undefined) {
    await humanNeeded(run, "register_offer", origin);
    return;
  }
  await humanNeeded(run, "login", "This page needs an account — sign in yourself, then scan again.");
}

/** Panel consent granted: create the account with a generated credential. */
export async function handleRegisterApprove(msg: Msg<"REGISTER_APPROVE">): Promise<void> {
  const run = runs.get(msg.tabId);
  const profile = await getProfile();
  if (!run || profile === undefined) return;
  await step(run, async () => {
    const origin = new URL(run.record.url).origin;
    const cred = {
      origin,
      email: profile.email,
      password: generatePassword(),
      createdAt: new Date().toISOString(),
    };
    await putCredential(cred); // stored BEFORE the attempt — a half-created account still needs its password
    run.authAttempted = true;
    run.record.phase = "registering";
    await emitState(run);
    const [firstName, ...rest] = profile.name.split(" ");
    await sendToTab(msg.tabId, {
      type: "REGISTER_FILL",
      tabId: msg.tabId,
      origin,
      mode: "registration",
      email: cred.email,
      password: cred.password,
      firstName,
      lastName: rest.join(" ") || undefined,
    });
  });
}

/** Content reports how the auth attempt went. */
export async function handleRegisterResult(msg: Msg<"REGISTER_RESULT">): Promise<void> {
  const run = runs.get(msg.tabId);
  if (!run) return;
  if (msg.ok) {
    // Wall cleared — restart the pipeline on the now-authenticated page.
    await startRun(msg.tabId);
    return;
  }
  await humanNeeded(
    run,
    "login",
    `Account step needs you at this portal (${msg.evidence.slice(0, 140)}). If a verification email arrived, tap its link, then scan again.`,
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Broadcast the plan, then gate on the user — or start filling in auto mode. */
async function planReady(run: Run): Promise<void> {
  const plan = run.plan;
  if (plan === undefined) return;
  await sendToRuntime({ type: "PLAN_READY", plan });
  if (plan.needsUser.length > 0) {
    run.record.phase = "awaiting_user";
    await emitState(run);
    return;
  }
  const { autonomy } = await getSettings();
  if (autonomy === "auto") {
    await handleExecutePlan({ type: "EXECUTE_PLAN", tabId: run.tabId, plan });
  } else {
    run.record.phase = "review"; // plan preview; panel sends EXECUTE_PLAN to approve
    await emitState(run);
  }
}

/** Build the LLM delegate from settings, or undefined when not configured. */
async function llmDelegate(): Promise<AnswerDelegate | undefined> {
  const { llm } = await getSettings();
  return llm === undefined ? undefined : makeLlmDelegate(createProvider(llm));
}

/**
 * Make sure we may script this origin. activeTab usually already covers the
 * tab the user invoked us on, so a declined (or gesture-blocked) optional
 * grant is not fatal — injection is attempted regardless and its error wins.
 */
async function ensureHostPermission(url: string): Promise<void> {
  const pattern = `${new URL(url).origin}/*`;
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return;
    await chrome.permissions.request({ origins: [pattern] });
  } catch {
    // chrome.permissions.request needs a user gesture it may not have here.
  }
}

/** Ping the tab; inject the content script and ping again when it is absent. */
async function ensureContentScript(tabId: number): Promise<Pong> {
  const alive = await pingTab(tabId);
  if (alive !== undefined) return alive;
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  const pong = await pingTab(tabId);
  if (pong === undefined) throw new Error("content script injected but not answering");
  return pong;
}

/** Broadcast the run's current record to the panel (and the link queue). */
async function emitState(run: Run): Promise<void> {
  await sendToRuntime({ type: "RUN_STATE", record: run.record });
  await noteRunPhase(run.tabId, run.record.phase).catch(() => undefined);
}

/** Pause the run and show the panel's "your turn" card. */
async function humanNeeded(
  run: Run,
  reason: Msg<"HUMAN_NEEDED">["reason"],
  detail: string,
): Promise<void> {
  run.record.phase = "awaiting_user";
  await sendToRuntime({ type: "HUMAN_NEEDED", tabId: run.tabId, reason, detail });
  await emitState(run);
}

/** Terminal failure: log it, persist the audit trail, tell the panel. */
async function fail(run: Run, detail: string): Promise<void> {
  console.warn(`[larpmaxer] run ${run.record.id} failed: ${detail}`);
  run.record.phase = "error";
  await addRecord(run.record).catch(() => undefined);
  await emitState(run);
}

/** Run one handler step; any throw becomes a terminal error on the run. */
async function step(run: Run, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    await fail(run, String(err));
  }
}
