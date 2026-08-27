/**
 * LarpMaxer content script — the only LarpMaxer code that runs inside the ATS
 * page. Deliberately thin (ARCHITECTURE.md): adapters and fill know-how live
 * in @larpmaxer/core; this file wires them to the live document and answers
 * the background worker over the typed Message protocol. It never talks to
 * the LLM and never sees credentials or the API key.
 */

import {
  findAuthForm,
  attachFile,
  comboboxSelect,
  needsTrustedKeyboard,
  pickAdapter,
  readBack,
  setCheckbox as setNativeCheckbox,
  setNativeValue,
} from "@larpmaxer/core";
import type {
  Adapter,
  FieldKind,
  FieldReport,
  FillPlan,
  FillReport,
  FormField,
  Message,
  ResolvedAnswer,
} from "@larpmaxer/core";
import { detectHumanNeeded, hasPasswordField, type HumanBlocker } from "./humanNeeded";
import type { Pong } from "../lib/messaging";

// ---------------------------------------------------------------------------
// Tunables.
// ---------------------------------------------------------------------------

// One breath for framework re-renders when the adapter declares no settleMs.
const DEFAULT_SETTLE_MS = 100;

// How long to watch the page after clicking submit before judging the result.
const SUBMIT_WAIT_MS = 3000;

// ---------------------------------------------------------------------------
// Message wiring.
// ---------------------------------------------------------------------------

/**
 * Liveness handshake the background sends before driving this page
 * (`Ping`/`Pong` in lib/messaging.ts — deliberately NOT part of the core
 * Message union). The ping is the ONE place `sendResponse` is used; every
 * core result below travels one-way via chrome.runtime.sendMessage, because
 * the background listens on the broadcast channel, not on reply callbacks.
 */
function isPing(raw: unknown): raw is { type: "LARPMAXER_PING" } {
  return (
    typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "LARPMAXER_PING"
  );
}

/** Fire-and-forget a core message to the background (rejection = no listener; ignore). */
function sendResult(msg: Message): void {
  void Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => undefined);
}

/** Adapter matched on this page; re-picked on every DETECT_REQUEST (SPA navigations). */
let currentAdapter: Adapter | null = null;

function adapterForPage(): Adapter | null {
  currentAdapter ??= pickAdapter(window.location.href, document);
  return currentAdapter;
}

chrome.runtime.onMessage.addListener(
  (raw: unknown, _sender, sendResponse): boolean | undefined => {
    if (isPing(raw)) {
      sendResponse({
        type: "LARPMAXER_PONG",
        hasPasswordField: hasPasswordField(document),
      } satisfies Pong);
      return undefined;
    }
    const msg = raw as Message;
    switch (msg.type) {
      case "DETECT_REQUEST": {
        currentAdapter = pickAdapter(window.location.href, document);
        const jobTitle = findJobTitle();
        sendResult({
          type: "DETECT_RESULT",
          tabId: msg.tabId,
          adapterId: currentAdapter?.id ?? null,
          ...(jobTitle !== undefined ? { jobTitle } : {}),
        });
        return undefined;
      }
      case "DISCOVER_REQUEST": {
        const adapter = adapterForPage();
        let fields: FormField[] = [];
        try {
          fields = adapter ? adapter.discover(document) : [];
        } catch {
          fields = []; // a broken page must not kill the message channel
        }
        sendResult({ type: "DISCOVER_RESULT", tabId: msg.tabId, fields });
        return undefined;
      }
      case "EXECUTE_PLAN": {
        executePlan(msg.tabId, msg.plan)
          .catch(
            (err): Message => ({
              type: "FILL_REPORT",
              tabId: msg.tabId,
              report: {
                url: window.location.href,
                adapterId: msg.plan.adapterId,
                fields: [{ fieldId: "*", label: "fill run", outcome: "failed", error: errText(err) }],
                complete: false,
              },
            }),
          )
          .then(sendResult);
        return undefined;
      }
      case "REGISTER_FILL": {
        void handleRegisterFill(msg);
        return undefined;
      }
      case "APPROVE_SUBMIT": {
        approveSubmit(msg.tabId)
          .catch(
            (err): Message => ({
              type: "SUBMIT_RESULT",
              tabId: msg.tabId,
              result: { submitted: false, evidence: [errText(err)] },
            }),
          )
          .then(sendResult);
        return undefined;
      }
      default:
        return undefined; // message addressed to another surface
    }
  },
);

/** Job title for the run header: document.title, falling back to the first h1. */
function findJobTitle(): string | undefined {
  const title = document.title.trim();
  if (title !== "") return title;
  const h1 = document.querySelector("h1")?.textContent?.trim();
  return h1 !== undefined && h1 !== "" ? h1 : undefined;
}

/** Fire-and-forget HUMAN_NEEDED to the background (rejection = no listener; ignore). */
function notifyHumanNeeded(tabId: number, blocker: HumanBlocker): void {
  const msg: Message = { type: "HUMAN_NEEDED", tabId, reason: blocker.reason, detail: blocker.detail };
  void Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// EXECUTE_PLAN — fill, settle, read back, report.
// ---------------------------------------------------------------------------

/** A fill that ran without throwing, awaiting its post-settle read-back grade. */
interface PendingVerification {
  field: FormField;
  answer: ResolvedAnswer;
  el: HTMLElement;
  usedTrustedTyping: boolean;
}

async function executePlan(tabId: number, plan: FillPlan): Promise<Message> {
  const report: FillReport = {
    url: window.location.href,
    adapterId: plan.adapterId,
    fields: [],
    complete: false,
  };

  // Contract (types.ts): a plan is not executable while needsUser is non-empty.
  if (plan.needsUser.length > 0) {
    report.fields = plan.needsUser.map((q) => ({
      fieldId: q.fieldId,
      label: q.label,
      outcome: "skipped" as const,
      error: "awaiting user answer",
    }));
    return { type: "FILL_REPORT", tabId, report };
  }

  // A login wall means nothing can be filled. A CAPTCHA does NOT block
  // filling (only submission), so we fill through it and gate at submit.
  const blocker = detectHumanNeeded(document);
  if (blocker !== null && blocker.reason === "login") {
    notifyHumanNeeded(tabId, blocker);
    return { type: "FILL_REPORT", tabId, report };
  }

  const adapter = adapterForPage();
  if (adapter === null) {
    report.fields = plan.answers.map((a) => ({
      fieldId: a.fieldId,
      label: a.fieldId,
      outcome: "failed" as const,
      error: "no adapter matches this page",
    }));
    return { type: "FILL_REPORT", tabId, report };
  }

  // Selectors can go stale between discover and execute on SPA forms, so
  // re-discover now and join the plan's answers to live fields by id.
  const fields = new Map(adapter.discover(document).map((f) => [f.id, f] as const));
  const quirks = adapter.quirks ?? {};

  const pending: PendingVerification[] = [];
  for (const answer of plan.answers) {
    const field = fields.get(answer.fieldId);
    if (field === undefined) {
      report.fields.push({
        fieldId: answer.fieldId,
        label: answer.fieldId,
        outcome: "failed",
        error: "field not found on page",
      });
      continue;
    }
    const el = document.querySelector<HTMLElement>(field.selector);
    if (el === null) {
      report.fields.push({
        fieldId: field.id,
        label: field.label,
        outcome: "failed",
        error: `selector did not resolve: ${field.selector}`,
      });
      continue;
    }
    // Hard product-rule guard (humans own credentials): even if an adapter
    // ever discovers one, a password (or hidden) input is never filled.
    if (el instanceof HTMLInputElement && (el.type === "password" || el.type === "hidden")) {
      report.fields.push({
        fieldId: field.id,
        label: field.label,
        outcome: "skipped",
        error: `refusing to fill an input[type="${el.type}"] — credentials and hidden fields are humans-only`,
      });
      continue;
    }
    // Text-like kinds in trustedKeyboardOnly get keystroke simulation below;
    // a non-text kind in that list (e.g. combobox) is core's own job to honour.
    const usedTrustedTyping = needsTrustedKeyboard(field, quirks) && isTextLike(field.kind);
    try {
      await fillOne(el, field, answer, usedTrustedTyping);
      pending.push({ field, answer, el, usedTrustedTyping });
    } catch (err) {
      report.fields.push({ fieldId: field.id, label: field.label, outcome: "failed", error: errText(err) });
    }
  }

  // Let the page's framework settle (state commits, async re-formatting)
  // before trusting anything we read back.
  await sleep(quirks.settleMs ?? DEFAULT_SETTLE_MS);

  for (const p of pending) report.fields.push(verifyField(p));

  // Required fields the plan never answered still count against completeness.
  const answered = new Set(plan.answers.map((a) => a.fieldId));
  for (const field of fields.values()) {
    if (field.required && !answered.has(field.id)) {
      report.fields.push({ fieldId: field.id, label: field.label, outcome: "skipped", error: "no answer in plan" });
    }
  }

  const outcomes = new Map(report.fields.map((f) => [f.fieldId, f.outcome] as const));
  report.complete = Array.from(fields.values())
    .filter((f) => f.required)
    .every((f) => outcomes.get(f.id) === "filled" || outcomes.get(f.id) === "verified");

  return { type: "FILL_REPORT", tabId, report };
}

/** Route one answer to the right fill strategy for its field kind. */
async function fillOne(
  el: HTMLElement,
  field: FormField,
  answer: ResolvedAnswer,
  usedTrustedTyping: boolean,
): Promise<void> {
  const text = answerText(answer.value);
  switch (field.kind) {
    case "file": {
      await attachResume(el, answer);
      return;
    }
    case "combobox": {
      if (!(el instanceof HTMLInputElement)) {
        throw new Error(`"${field.label}" is not a combobox input (${el.tagName.toLowerCase()})`);
      }
      // Core drives the type→await-listbox→click dance; a miss throws with
      // the option texts it actually saw.
      await comboboxSelect(document, el, text);
      return;
    }
    case "yesno": {
      const target = findOptionButton(el, text);
      if (target === null) throw new Error(`no option control matching "${text}"`);
      target.click();
      return;
    }
    case "checkbox": {
      // A group answer ("Sydney") checks the matching member; a boolean-ish
      // answer toggles the single checkbox the selector resolved to.
      if (isChoiceAnswer(field, answer.value)) {
        clickGroupChoice(el, field, "checkbox", text);
      } else {
        setCheckboxState(el, answer.value);
      }
      return;
    }
    case "radio": {
      clickGroupChoice(el, field, "radio", text);
      return;
    }
    case "select": {
      selectOption(el, text);
      return;
    }
    default: {
      const input = asTextControl(el, field);
      if (usedTrustedTyping) {
        typeWithSyntheticKeystrokes(input, text);
      } else {
        setNativeValue(input, text);
      }
    }
  }
}

/**
 * Attach a resume without an OS file dialog. The background embeds the file
 * bytes as base64 in the answer's `value` (ResumeRef carries metadata only),
 * so decode here and hand core's attachFile a real byte array.
 */
async function attachResume(el: HTMLElement, answer: ResolvedAnswer): Promise<void> {
  if (!(el instanceof HTMLInputElement) || el.type !== "file") {
    throw new Error("selector did not resolve to a file input");
  }
  if (answer.resume === undefined) throw new Error("file answer has no resume attached");
  if (typeof answer.value !== "string" || answer.value.length === 0) {
    throw new Error("file answer carries no base64 payload");
  }
  const bytes = base64ToBytes(answer.value);
  await Promise.resolve(attachFile(el, bytes, answer.resume.filename, answer.resume.mime));
}

/**
 * Best-effort "typing" for frameworks that ignore programmatic value writes.
 *
 * Production lesson: setting `el.value` from JS — even through the native
 * setter — may never register with React. Controlled inputs re-render from
 * component state, so a value the framework never saw arrive as input events
 * is silently reverted on the next render. That is exactly why
 * `AdapterQuirks.trustedKeyboardOnly` and the post-settle read-back
 * verification exist. We mimic a keystroke stream per character
 * (keydown → keypress → incremental native-setter write + input → keyup),
 * which satisfies most listeners — but synthetic events are
 * `isTrusted: false`, and a page that checks trust can only be filled by a
 * human at the keyboard, so a read-back mismatch is reported as
 * failed: "needs real keystrokes".
 */
function typeWithSyntheticKeystrokes(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  el.focus();
  el.select();
  // Clear via the same channel the keystrokes use, so the framework sees one
  // consistent stream of input events.
  setNativeValue(el, "");
  let typed = "";
  for (const ch of text) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true, cancelable: true }));
    typed += ch;
    setNativeValue(el, typed); // dispatches the per-char input event (core fill/events)
    el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur();
}

/** Set a single checkbox via core's click-with-controlled-widget-fallback setter. */
function setCheckboxState(el: HTMLElement, value: string | boolean): void {
  if (!(el instanceof HTMLInputElement) || el.type !== "checkbox") {
    throw new Error("selector did not resolve to a checkbox");
  }
  setNativeCheckbox(el, desiredChecked(value));
}

/** Check the radio/checkbox in the field's group whose label or value matches the answer. */
function clickGroupChoice(
  el: HTMLElement,
  field: FormField,
  type: "radio" | "checkbox",
  text: string,
): void {
  const inputs = groupInputs(el, field, type);
  if (inputs.length === 0) throw new Error(`no ${type} inputs found for field`);
  const target = findGroupChoice(inputs, text);
  if (target === undefined) throw new Error(`no ${type} option matching "${text}"`);
  if (!target.checked) target.click();
}

/** Choose the <option> matching the answer by text or value, then set natively. */
function selectOption(el: HTMLElement, text: string): void {
  if (!(el instanceof HTMLSelectElement)) throw new Error("selector did not resolve to a <select>");
  const want = norm(text);
  const options = Array.from(el.options);
  const match =
    options.find((o) => norm(o.text) === want || norm(o.value) === want) ??
    options.find((o) => want !== "" && norm(o.text).includes(want));
  if (match === undefined) throw new Error(`no <option> matching "${text}"`);
  setNativeValue(el, match.value);
}

/**
 * Read the field back from the live DOM and grade the fill.
 * verified = the page now shows what the plan intended; filled = we acted and
 * a value is present but reformatted beyond safe comparison (masks, dates,
 * location autocompletes); failed = empty or reverted — which for
 * trustedKeyboardOnly kinds specifically means the synthetic keystrokes were
 * ignored ("needs real keystrokes").
 */
function verifyField(p: PendingVerification): FieldReport {
  const { field, answer, el, usedTrustedTyping } = p;
  const expected = answerText(answer.value);
  const base = { fieldId: field.id, label: field.label };

  switch (field.kind) {
    case "file": {
      const name = el instanceof HTMLInputElement ? el.files?.[0]?.name : undefined;
      if (name !== undefined && name === answer.resume?.filename) {
        return { ...base, outcome: "verified", finalValue: name };
      }
      if (name !== undefined) return { ...base, outcome: "filled", finalValue: name };
      return { ...base, outcome: "failed", error: "file did not attach" };
    }
    case "checkbox": {
      if (isChoiceAnswer(field, answer.value)) {
        const target = findGroupChoice(groupInputs(el, field, "checkbox"), expected);
        if (target === undefined) {
          return { ...base, outcome: "failed", error: `option "${expected}" not found at verify time` };
        }
        const finalValue = inputLabel(target);
        return target.checked
          ? { ...base, outcome: "verified", finalValue }
          : { ...base, outcome: "failed", finalValue, error: "checkbox state did not stick" };
      }
      const checked = el instanceof HTMLInputElement ? el.checked : false;
      const finalValue = String(checked);
      return checked === desiredChecked(answer.value)
        ? { ...base, outcome: "verified", finalValue }
        : { ...base, outcome: "failed", finalValue, error: "checkbox state did not stick" };
    }
    case "yesno": {
      const btn = findOptionButton(el, expected);
      if (btn === null) {
        return { ...base, outcome: "failed", error: `option "${expected}" not found at verify time` };
      }
      const finalValue = btn.textContent?.trim() ?? expected;
      // aria-pressed is the contract; aria-checked covers role=radio pairs.
      if (btn.getAttribute("aria-pressed") === "true" || btn.getAttribute("aria-checked") === "true") {
        return { ...base, outcome: "verified", finalValue };
      }
      if (!btn.hasAttribute("aria-pressed") && !btn.hasAttribute("aria-checked")) {
        // Clicked, but the control exposes no pressed state to read back.
        return { ...base, outcome: "filled", finalValue };
      }
      return { ...base, outcome: "failed", finalValue, error: "option did not register as pressed (aria-pressed)" };
    }
    case "radio": {
      const checked = groupInputs(el, field, "radio").find((r) => r.checked);
      if (checked === undefined) return { ...base, outcome: "failed", error: "no radio option selected" };
      const finalValue = inputLabel(checked);
      const want = norm(expected);
      if (norm(finalValue) === want || norm(checked.value) === want || norm(finalValue).includes(want)) {
        return { ...base, outcome: "verified", finalValue };
      }
      return { ...base, outcome: "filled", finalValue };
    }
    case "select": {
      const opt = el instanceof HTMLSelectElement ? el.selectedOptions[0] : undefined;
      const finalValue = opt?.text.trim() ?? "";
      const want = norm(expected);
      if (opt !== undefined && (norm(finalValue) === want || norm(opt.value) === want || norm(finalValue).includes(want))) {
        return { ...base, outcome: "verified", finalValue };
      }
      if (opt !== undefined && opt.value !== "") return { ...base, outcome: "filled", finalValue };
      return { ...base, outcome: "failed", finalValue, error: "selection did not stick" };
    }
    case "combobox": {
      const finalValue = safeReadBack(el);
      const a = norm(finalValue);
      const b = norm(expected);
      // Autocompletes legitimately expand the choice ("Sydney" →
      // "Sydney, New South Wales, Australia"), so match on containment.
      if (a !== "" && (a === b || a.includes(b) || b.includes(a))) {
        return { ...base, outcome: "verified", finalValue };
      }
      if (a !== "") return { ...base, outcome: "filled", finalValue };
      return { ...base, outcome: "failed", error: "combobox value is empty after selection" };
    }
    default: {
      const finalValue = safeReadBack(el);
      if (norm(expected) === "") {
        // An empty planned value means "leave blank".
        return finalValue.trim() === ""
          ? { ...base, outcome: "verified", finalValue }
          : { ...base, outcome: "filled", finalValue };
      }
      const matches =
        field.kind === "tel"
          ? digits(finalValue) === digits(expected) && digits(expected) !== ""
          : norm(finalValue) === norm(expected);
      if (matches) return { ...base, outcome: "verified", finalValue };
      if (usedTrustedTyping) return { ...base, outcome: "failed", finalValue, error: "needs real keystrokes" };
      if (finalValue.trim() !== "") return { ...base, outcome: "filled", finalValue }; // e.g. a mask/date widget reformatted it
      return { ...base, outcome: "failed", finalValue, error: "value did not persist after fill" };
    }
  }
}

// ---------------------------------------------------------------------------
// APPROVE_SUBMIT — click, wait, gather evidence.
// ---------------------------------------------------------------------------

async function approveSubmit(tabId: number): Promise<Message> {
  const fail = (why: string[]): Message => ({
    type: "SUBMIT_RESULT",
    tabId,
    result: { submitted: false, evidence: why },
  });

  const adapter = adapterForPage();
  if (adapter === null) return fail(["no adapter matches this page"]);

  // CAPTCHAs (and any login wall that appeared) gate submission — a human
  // must act first; we never solve or bypass them.
  const blocker = detectHumanNeeded(document);
  if (blocker !== null) {
    notifyHumanNeeded(tabId, blocker);
    return fail([`${blocker.reason} blocker: ${blocker.detail}`]);
  }

  const control = findSubmitControl(adapter);
  if (control === null) return fail([`submit control not found (selector: ${adapter.submitSelector})`]);
  control.click();

  await sleep(SUBMIT_WAIT_MS); // give the ATS time to submit and swap views

  const bodyText = (document.body?.innerText ?? "").toLowerCase();
  const markers = adapter.successMarkers.filter((m) => bodyText.includes(m.toLowerCase()));
  if (markers.length > 0) {
    return { type: "SUBMIT_RESULT", tabId, result: { submitted: true, evidence: markers } };
  }

  const alerts = Array.from(document.querySelectorAll('[role="alert"]'))
    .map((a) => a.textContent?.trim() ?? "")
    .filter((t) => t.length > 0);
  return fail(
    alerts.length > 0 ? alerts : ["no success marker or visible error within 3s of clicking submit"],
  );
}

/**
 * Ashby renders its submit button without a stable selector, so for that
 * adapter we locate it by visible text; everyone else trusts submitSelector,
 * with the text scan as a mutual fallback.
 */
function findSubmitControl(adapter: Adapter): HTMLElement | null {
  const bySelector = document.querySelector<HTMLElement>(adapter.submitSelector);
  const byText = findSubmitByText();
  return adapter.id === "ashby" ? (byText ?? bySelector) : (bySelector ?? byText);
}

function findSubmitByText(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]'),
  );
  for (const c of candidates) {
    const text = c instanceof HTMLInputElement ? c.value : (c.textContent ?? "");
    const usable =
      c.getClientRects().length > 0 && !c.hasAttribute("disabled") && c.getAttribute("aria-disabled") !== "true";
    if (usable && /\bsubmit\b/i.test(text)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

const TEXT_LIKE: ReadonlySet<FieldKind> = new Set<FieldKind>(["text", "email", "tel", "textarea", "date", "unknown"]);

function isTextLike(kind: FieldKind): boolean {
  return TEXT_LIKE.has(kind);
}

/** String form of an answer value; booleans read as the Yes/No a form shows. */
function answerText(value: string | boolean): string {
  return typeof value === "boolean" ? (value ? "Yes" : "No") : value;
}

const TRUTHY = new Set(["yes", "true", "1", "checked"]);

function desiredChecked(value: string | boolean): boolean {
  return typeof value === "boolean" ? value : TRUTHY.has(norm(value));
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function digits(s: string): string {
  return s.replace(/\D+/g, "");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asTextControl(el: HTMLElement, field: FormField): HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
  throw new Error(`"${field.label}" is not a text input (${el.tagName.toLowerCase()})`);
}

function base64ToBytes(b64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(b64.replace(/^data:[^,]*,/, "")); // tolerate a data: URL prefix
  } catch {
    throw new Error("invalid base64 resume payload");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const OPTION_CONTROL_SELECTOR = 'button, [role="button"], [role="radio"]';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the clickable option (Ashby-style Yes/No button pairs) whose visible
 * text matches. Searches the field element itself, its descendants, then its
 * parent — selectors sometimes land on one button of the pair, sometimes on
 * the group container.
 */
function findOptionButton(root: HTMLElement, text: string): HTMLElement | null {
  const want = norm(text);
  if (want === "") return null;
  // Whole-word prefix so "No" never matches "Not applicable".
  const boundary = new RegExp(`^${escapeRegExp(want)}(?:\\b|$)`);
  const scopes: HTMLElement[] = root.parentElement !== null ? [root, root.parentElement] : [root];
  for (const scope of scopes) {
    const candidates: HTMLElement[] = scope.matches(OPTION_CONTROL_SELECTOR) ? [scope] : [];
    candidates.push(...Array.from(scope.querySelectorAll<HTMLElement>(OPTION_CONTROL_SELECTOR)));
    const exact = candidates.find((c) => norm(c.textContent ?? "") === want);
    if (exact !== undefined) return exact;
    const prefixed = candidates.find((c) => boundary.test(norm(c.textContent ?? ""))); // "Yes ✓" decorations
    if (prefixed !== undefined) return prefixed;
  }
  return null;
}

const FALSY = new Set(["no", "false", "0", "n"]);

/** True when a checkbox answer names one option of a group ("Sydney") rather than a checked state. */
function isChoiceAnswer(field: FormField, value: string | boolean): value is string {
  return (
    typeof value === "string" &&
    (field.options?.length ?? 0) > 0 &&
    !TRUTHY.has(norm(value)) &&
    !FALSY.has(norm(value))
  );
}

/**
 * All radio/checkbox inputs in the field's group: every element the field's
 * own selector matches (group selectors like `input[name=…]` or
 * `input[id^=…_]` hit all members), else expansion by shared name, else the
 * inputs contained in the resolved element.
 */
function groupInputs(el: HTMLElement, field: FormField, type: "radio" | "checkbox"): HTMLInputElement[] {
  const isMember = (n: Element): n is HTMLInputElement => n instanceof HTMLInputElement && n.type === type;
  const bySelector = Array.from(document.querySelectorAll(field.selector)).filter(isMember);
  if (bySelector.length > 1) return bySelector;
  if (el instanceof HTMLInputElement && el.type === type) {
    if (el.name !== "") {
      return Array.from(
        document.querySelectorAll<HTMLInputElement>(`input[type="${type}"][name="${CSS.escape(el.name)}"]`),
      );
    }
    return [el];
  }
  return Array.from(el.querySelectorAll<HTMLInputElement>(`input[type="${type}"]`));
}

/** The group member whose label or value matches the answer (exact first, then label containment). */
function findGroupChoice(inputs: HTMLInputElement[], text: string): HTMLInputElement | undefined {
  const want = norm(text);
  return (
    inputs.find((r) => norm(inputLabel(r)) === want || norm(r.value) === want) ??
    inputs.find((r) => want !== "" && norm(inputLabel(r)).includes(want))
  );
}

function inputLabel(r: HTMLInputElement): string {
  const label = r.labels?.[0]?.textContent ?? r.closest("label")?.textContent ?? "";
  const trimmed = label.trim();
  return trimmed !== "" ? trimmed : r.value;
}

/** Core readBack with a plain-DOM fallback so one odd element cannot sink the report. */
function safeReadBack(el: HTMLElement): string {
  try {
    return readBack(el);
  } catch {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return el.textContent?.trim() ?? "";
  }
}

/** Fill the portal's login/registration form with the managed credential. */
async function handleRegisterFill(
  msg: Extract<Message, { type: "REGISTER_FILL" }>,
): Promise<void> {
  const form = findAuthForm(document);
  const fail = (evidence: string): void => {
    void chrome.runtime.sendMessage({
      type: "REGISTER_RESULT", tabId: msg.tabId, ok: false, evidence,
    } satisfies Message);
  };
  // Origin guard: a redirect or soft navigation between detection and fill must
  // never deliver the managed password to a different site.
  if (location.origin !== msg.origin) {
    return fail(
      `origin changed (${msg.origin} -> ${location.origin}); refusing to fill credentials`,
    );
  }
  if (form === null) return fail("no fillable auth form found");
  if (msg.mode === "registration" && form.kind !== "registration") {
    return fail("only a login form is visible; the portal may need its registration page opened");
  }
  try {
    const set = (sel: string, value: string): void => {
      const el = document.querySelector<HTMLInputElement>(sel);
      if (el) setNativeValue(el, value);
    };
    set(form.emailSelector, msg.email);
    for (const sel of form.passwordSelectors) set(sel, msg.password);
    if (msg.firstName !== undefined && form.firstNameSelector !== undefined) {
      set(form.firstNameSelector, msg.firstName);
    }
    if (msg.lastName !== undefined && form.lastNameSelector !== undefined) {
      set(form.lastNameSelector, msg.lastName);
    }
    if (form.nameSelector !== undefined) {
      set(form.nameSelector, [msg.firstName, msg.lastName].filter(Boolean).join(" ") || msg.email);
    }
    document.querySelector<HTMLElement>(form.submitSelector)?.click();
    await new Promise((r) => setTimeout(r, 3500));
    // Success heuristic: the password wall is gone and no visible error text.
    const stillWalled = document.querySelector('input[type="password"]') !== null;
    const errText = [...document.querySelectorAll('[role="alert"], [class*="error" i]')]
      .map((e) => e.textContent?.trim() ?? "").filter((t) => t !== "").join(" | ").slice(0, 200);
    if (!stillWalled && errText === "") {
      void chrome.runtime.sendMessage({
        type: "REGISTER_RESULT", tabId: msg.tabId, ok: true, evidence: "auth wall cleared",
      } satisfies Message);
    } else {
      fail(errText !== "" ? errText : "password field still present (verification email likely)");
    }
  } catch (err) {
    fail(String(err));
  }
}
