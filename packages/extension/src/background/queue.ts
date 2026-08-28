/**
 * The link queue — "apply to anything".
 *
 * The user drops a job URL into the side panel; this module opens it in a
 * background tab, hands it to the run state machine, and narrates progress
 * back to the panel as QUEUE_STATE broadcasts. Jobs run one at a time —
 * a queue of tabs filling in parallel is how you get rate-limited and how
 * users lose track of what was sent where.
 *
 * Human-only steps pause the queue on that job (status "awaiting_user");
 * the panel's "your turn" card resumes it exactly like a foreground run.
 */

import type { Message, QueuedJob, RunPhase } from "@larpmaxer/core";
import { canonicalizeJobUrl } from "@larpmaxer/core";
import { sendToRuntime } from "../lib/messaging.js";
import { startRun } from "./run.js";

const KEY_QUEUE = "queue";

/** Single in-flight guard: only one job may own a worker tab at a time. */
let working = false;

async function load(): Promise<QueuedJob[]> {
  const got = await chrome.storage.local.get(KEY_QUEUE);
  return (got[KEY_QUEUE] as QueuedJob[] | undefined) ?? [];
}

async function save(jobs: QueuedJob[]): Promise<void> {
  await chrome.storage.local.set({ [KEY_QUEUE]: jobs });
  await sendToRuntime({ type: "QUEUE_STATE", jobs });
}

/** Panel asked for the current queue (e.g. on open). */
export async function broadcast(): Promise<void> {
  await sendToRuntime({ type: "QUEUE_STATE", jobs: await load() });
}

/** Accept a dropped link; refuses obvious non-job URLs early. */
export async function handleQueueLink(msg: Extract<Message, { type: "QUEUE_LINK" }>): Promise<void> {
  const url = msg.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
  } catch {
    return; // panel validates too; silently ignore garbage
  }
  if (parsed.protocol !== "https:") return;
  // A link copied from a job board is often the SEARCH page with the job as a
  // query param; canonicalize so the worker tab opens the posting itself.
  parsed = new URL(canonicalizeJobUrl(parsed.href));

  const jobs = await load();
  if (jobs.some((j) => j.url === parsed.href && j.status !== "error")) return; // dedupe
  jobs.unshift({
    id: crypto.randomUUID(),
    url: parsed.href,
    status: "queued",
    addedAt: new Date().toISOString(),
  });
  await save(jobs);
  void pump();
}

/** Remove a job; closes its worker tab if one is still open. */
export async function handleQueueRemove(
  msg: Extract<Message, { type: "QUEUE_REMOVE" }>,
): Promise<void> {
  const jobs = await load();
  const job = jobs.find((j) => j.id === msg.jobId);
  if (job?.tabId !== undefined) {
    await chrome.tabs.remove(job.tabId).catch(() => undefined);
  }
  await save(jobs.filter((j) => j.id !== msg.jobId));
  void pump();
}

/** Run state machine progress hook — run.ts calls this on every phase change. */
export async function noteRunPhase(tabId: number, phase: RunPhase): Promise<void> {
  const jobs = await load();
  const job = jobs.find((j) => j.tabId === tabId);
  if (!job) return;

  const map: Partial<Record<RunPhase, QueuedJob["status"]>> = {
    detecting: "running",
    discovering: "running",
    resolving: "running",
    filling: "running",
    submitting: "running",
    awaiting_user: "awaiting_user",
    review: "review",
    done: "sent",
    error: "error",
  };
  const next = map[phase];
  if (next === undefined || next === job.status) return;
  job.status = next;
  if (next === "sent" || next === "error") {
    working = false;
    if (next === "sent" && job.tabId !== undefined) {
      // Leave the success page open briefly is tempting, but tab hygiene wins.
      await chrome.tabs.remove(job.tabId).catch(() => undefined);
    }
    job.tabId = undefined;
  }
  await save(jobs);
  if (next === "sent" || next === "error") void pump();
}

/** Detection results carry the job's identity — mirror it onto the queue card. */
export async function noteDetect(
  tabId: number,
  adapterId: string | null,
  jobTitle?: string,
): Promise<void> {
  const jobs = await load();
  const job = jobs.find((j) => j.tabId === tabId);
  if (!job) return;
  if (adapterId === null) {
    job.status = "unsupported";
    job.note = "No form LarpMaxer recognises — open the tab and apply manually.";
    working = false;
    job.tabId = undefined;
  } else {
    job.adapterId = adapterId;
    job.jobTitle = jobTitle;
  }
  await save(jobs);
  if (adapterId === null) void pump();
}

/** Start the next queued job if no worker is active. */
async function pump(): Promise<void> {
  if (working) return;
  const jobs = await load();
  const next = jobs.find((j) => j.status === "queued");
  if (!next) return;
  working = true;

  next.status = "opening";
  await save(jobs);

  try {
    const tab = await chrome.tabs.create({ url: next.url, active: false });
    if (tab.id === undefined) throw new Error("tab has no id");
    next.tabId = tab.id;
    await save(jobs);
    await waitForLoad(tab.id);
    await startRun(tab.id);
  } catch (err) {
    next.status = "error";
    next.note = String(err);
    next.tabId = undefined;
    working = false;
    await save(jobs);
    void pump();
  }
}

/** Resolve when the tab reports complete (or after a generous timeout). */
function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: { status?: string }): void => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") done();
    });
  });
}
