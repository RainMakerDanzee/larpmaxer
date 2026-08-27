/**
 * Background service worker entry: opens the side panel from the toolbar
 * button and routes every runtime message to the run state machine.
 */

import { isMessage, type Message } from "@larpmaxer/core";
import { onMessage } from "../lib/messaging.js";
import * as run from "./run.js";
import * as queue from "./queue.js";
import * as resume from "./resume.js";

// Toolbar button opens the side panel (MV3-sanctioned; needs Chrome 114+).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[larpmaxer] sidePanel behavior:", err));

onMessage((msg, sender) => {
  route(msg, sender).catch((err) => console.error("[larpmaxer] route:", err));
});

/** One dispatch per message type; progress flows back as RUN_STATE broadcasts. */
async function route(msg: Message, sender: chrome.runtime.MessageSender): Promise<void> {
  // Content scripts cannot know their own tab id and merely echo the one they
  // were sent; for messages arriving FROM a tab, the sender is authoritative.
  if (sender.tab?.id !== undefined && "tabId" in msg) {
    (msg as { tabId: number }).tabId = sender.tab.id;
  }

  if (isMessage(msg, "DETECT_REQUEST")) return run.startRun(msg.tabId);
  if (isMessage(msg, "DETECT_RESULT")) return run.handleDetectResult(msg);
  if (isMessage(msg, "DISCOVER_REQUEST")) return run.handleDiscoverRequest(msg);
  if (isMessage(msg, "DISCOVER_RESULT")) return run.handleDiscoverResult(msg);
  if (isMessage(msg, "INTAKE_ANSWER")) return run.handleIntakeAnswer(msg);
  if (isMessage(msg, "EXECUTE_PLAN")) return run.handleExecutePlan(msg);
  if (isMessage(msg, "FILL_REPORT")) return run.handleFillReport(msg);
  if (isMessage(msg, "APPROVE_SUBMIT")) return run.handleApproveSubmit(msg);
  if (isMessage(msg, "SUBMIT_RESULT")) return run.handleSubmitResult(msg);
  if (isMessage(msg, "REGISTER_APPROVE")) return run.handleRegisterApprove(msg);
  if (isMessage(msg, "REGISTER_RESULT")) return run.handleRegisterResult(msg);
  if (isMessage(msg, "QUEUE_LINK")) return queue.handleQueueLink(msg);
  if (isMessage(msg, "QUEUE_REMOVE")) return queue.handleQueueRemove(msg);
  if (isMessage(msg, "QUEUE_STATE")) return queue.broadcast(); // panel ping-for-state
  if (isMessage(msg, "REFINE_RESUME_REQUEST")) return resume.handleRefineRequest(msg);
  // PLAN_READY / RUN_STATE / HUMAN_NEEDED are background→panel broadcasts;
  // they never need routing here.
}
