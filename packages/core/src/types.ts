/**
 * Shared contracts for LarpMaxer. This file is the single source of truth:
 * every package imports these types and none redefines them.
 *
 * Design rule: no DOM types here — types must be usable in Node (tests, CLIs).
 */

// The message protocol carries a resume parse, whose shape resume/extract.ts
// owns. Type-only, so this import is erased and forms no runtime cycle.
import type { ParsedResume } from "./resume/extract.js";
import type { PageSurvey } from "./discovery/survey.js";

// ---------------------------------------------------------------------------
// Profile — everything LarpMaxer is allowed to say about the user.
// ---------------------------------------------------------------------------

/** One prior role on the user's CV. */
export interface Experience {
  title: string;
  company: string;
  /** ISO date (YYYY-MM) — start of the role. */
  start: string;
  /** ISO date (YYYY-MM) or "present". */
  end: string;
  location?: string;
  /** Bullet points, already written truthfully by the user. */
  highlights: string[];
}

export interface Education {
  institution: string;
  qualification: string;
  /** Year completed (or expected). */
  year?: string;
  notes?: string;
}

/** A reusable answer to a screening question, keyed for fuzzy lookup. */
export interface QAEntry {
  /** Canonical question this answers, e.g. "Do you require sponsorship?" */
  question: string;
  answer: string;
  /** Set true once the user has explicitly approved this exact wording. */
  approved: boolean;
  /** Times this entry has been used to fill a form. */
  uses: number;
}

/**
 * The user's complete application identity. This object is the ONLY source
 * of facts the engine and the LLM may draw on. Local-only, user-owned.
 */
export interface Profile {
  name: string;
  email: string;
  phone: string;
  /** "City, State, Country" — used for location typeaheads. */
  location: string;
  links: { label: string; url: string }[];
  /** Work-rights statement, e.g. "Australian permanent resident". */
  workRights: string;
  /** True if the user requires visa sponsorship at the target location. */
  needsSponsorship: boolean;
  noticePeriod: string;
  /** Optional salary expectation text, e.g. "A$95,000–115,000". */
  salary?: string;
  summary: string;
  skills: string[];
  experience: Experience[];
  education: Education[];
  qaBank: QAEntry[];
  /** Resume files by purpose; bytes are stored separately (see ResumeRef). */
  resumes: ResumeRef[];
}

/** Reference to a stored resume file (bytes live in extension storage). */
export interface ResumeRef {
  id: string;
  filename: string;
  /** MIME type, e.g. application/pdf. */
  mime: string;
  /** Optional tag such as "data", "governance" to pick per job family. */
  tag?: string;
}

// ---------------------------------------------------------------------------
// Form model — what an adapter finds on a page.
// ---------------------------------------------------------------------------

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "textarea"
  | "select"
  | "combobox"
  | "radio"
  | "checkbox"
  | "yesno"
  | "file"
  | "date"
  | "unknown";

/**
 * One fillable field discovered on an application form.
 * `selector` must uniquely identify the element within the document at fill
 * time; adapters prefer stable ids/names over positional selectors.
 */
export interface FormField {
  /** Stable id for this field within the plan (adapter-chosen). */
  id: string;
  kind: FieldKind;
  /** Human label as the applicant sees it. */
  label: string;
  /** CSS selector that resolves to the input element. */
  selector: string;
  required: boolean;
  /** For select/radio/yesno: the choices offered. */
  options?: string[];
  /** Extra hint for the answer engine (placeholder, aria-description...). */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Answering — how a field gets its value.
// ---------------------------------------------------------------------------

/** Where an answer came from — kept for the action log and the review UI. */
export type AnswerSource =
  | "profile"    // direct field mapping (name, email, phone…)
  | "qa_bank"    // reusable approved answer
  | "llm"        // formatted/selected by the LLM from profile evidence
  | "user";      // asked during this run via the intake queue

export interface ResolvedAnswer {
  fieldId: string;
  value: string | boolean;
  source: AnswerSource;
  /** For file fields: the chosen resume. */
  resume?: ResumeRef;
}

/** A field the engine refuses to guess — surfaced to the user. */
export interface OpenQuestion {
  fieldId: string;
  label: string;
  options?: string[];
  /** Why it could not be answered from the profile. */
  reason: string;
}

/** Everything needed to fill one application form. */
export interface FillPlan {
  adapterId: string;
  url: string;
  jobTitle?: string;
  company?: string;
  answers: ResolvedAnswer[];
  /** Fields awaiting the user; plan is not executable while non-empty. */
  needsUser: OpenQuestion[];
  /**
   * The field model this plan was built from, carried only when it did not
   * come from an adapter — i.e. a model classified the page. The executor
   * re-discovers through the adapter when this is absent, which is what keeps
   * SPA selectors fresh; for a classified page there is nothing to re-discover
   * through, so the model travels with the plan.
   */
  fields?: FormField[];
  /** Submit control for a classified page, chosen from the page's own buttons. */
  submitSelector?: string;
}

// ---------------------------------------------------------------------------
// Execution — what actually happened in the page.
// ---------------------------------------------------------------------------

export type FillOutcome = "filled" | "verified" | "failed" | "skipped";

export interface FieldReport {
  fieldId: string;
  label: string;
  outcome: FillOutcome;
  /** Value as read back from the DOM after filling (redacted for review). */
  finalValue?: string;
  error?: string;
}

export interface FillReport {
  url: string;
  adapterId: string;
  fields: FieldReport[];
  /** True when every required field reports filled/verified. */
  complete: boolean;
}

/** Result of pressing submit and watching the page. */
export interface SubmitResult {
  submitted: boolean;
  /** Success text found, or the validation errors that blocked it. */
  evidence: string[];
}

// ---------------------------------------------------------------------------
// Adapters — per-ATS knowledge.
// ---------------------------------------------------------------------------

/**
 * An adapter teaches LarpMaxer one applicant-tracking system.
 * Implementations must be pure over the passed document — no globals — so
 * they can run against fixtures in Node tests.
 */
export interface Adapter {
  /** Stable id, e.g. "greenhouse". */
  id: string;
  /** Display name for the UI. */
  name: string;
  /** Fast URL test — cheap pre-filter before detect(). */
  matchesUrl(url: string): boolean;
  /** Deep check against the live document. */
  detect(url: string, doc: Document): boolean;
  /** Find every fillable field on the application form. */
  discover(doc: Document): FormField[];
  /** Selector for the submit control. */
  submitSelector: string;
  /** Text fragments that prove a successful submission. */
  successMarkers: string[];
  /**
   * ATS-specific behaviours the executor must apply,
   * e.g. { trustedKeyboardOnly: ["text", "email"] } for Ashby-style React forms.
   */
  quirks?: AdapterQuirks;
}

export interface AdapterQuirks {
  /** Field kinds whose values only register via trusted keyboard events. */
  trustedKeyboardOnly?: FieldKind[];
  /** Wait (ms) after filling before reading back values. */
  settleMs?: number;
  /** True when the form paginates and needs Next-button traversal. */
  paginated?: boolean;
  /**
   * Selector for the control that advances a paginated form.
   *
   * Optional: without it the executor scans for an unambiguous forward label.
   * Supply it whenever the ATS has a stable one — guessing from text is the
   * fallback, and the cost of guessing wrong is a half-filled submission.
   */
  nextSelector?: string;
}

// ---------------------------------------------------------------------------
// Runs & autonomy.
// ---------------------------------------------------------------------------

export type AutonomyMode = "review" | "auto";

export type RunPhase =
  | "idle"
  | "detecting"
  | "discovering"
  | "resolving"
  | "awaiting_user"   // intake questions or a human-only step (login/CAPTCHA)
  | "registering"     // creating or entering a portal account (docs/registration.md)
  | "filling"
  | "review"          // artifact preview awaiting approval (review mode)
  | "submitting"
  | "done"
  | "error";

export interface ApplicationRecord {
  id: string;
  url: string;
  company?: string;
  jobTitle?: string;
  adapterId: string;
  submittedAt?: string;
  phase: RunPhase;
  /** The plan as approved (resume answers hold filenames, never bytes). */
  plan?: FillPlan;
  report?: FillReport;
  submit?: SubmitResult;
}

// ---------------------------------------------------------------------------
// Link queue — "apply to anything": paste a URL, LarpMaxer does the rest.
// ---------------------------------------------------------------------------

/** Lifecycle of one dropped link, panel-facing. */
export type QueueStatus =
  | "queued"        // accepted, waiting for a worker tab
  | "opening"       // background tab created, page loading
  | "running"       // detect → discover → resolve → fill in progress
  | "awaiting_user" // intake questions or a human-only step (login/CAPTCHA)
  | "review"        // filled; artifact awaits approval
  | "sent"          // submitted successfully
  | "unsupported"   // no adapter matched and generic found no form
  | "error";

/** One job the user dropped into the queue. */
export interface QueuedJob {
  id: string;
  url: string;
  /** Filled in after detection. */
  company?: string;
  jobTitle?: string;
  adapterId?: string;
  /** Worker tab currently owning this job, while one exists. */
  tabId?: number;
  status: QueueStatus;
  /** One-line human note for error/unsupported states. */
  note?: string;
  /** ISO timestamp when the link was dropped. */
  addedAt: string;
}

// ---------------------------------------------------------------------------
// Portal credentials — autonomous registration (docs/registration.md).
// ---------------------------------------------------------------------------

/**
 * One portal account LarpMaxer created with the user's one-time consent.
 * Lives only in extension storage; the browser's own password manager is the
 * primary store (fill uses autocomplete="new-password" semantics).
 */
export interface PortalCredential {
  /** Origin the credential belongs to, e.g. "https://careers.example.com". */
  origin: string;
  email: string;
  password: string;
  createdAt: string;
  lastUsedAt?: string;
}

// ---------------------------------------------------------------------------
// LLM provider — BYO key, evidence-constrained.
// ---------------------------------------------------------------------------

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmProvider {
  /** `chrome` is the browser's own on-device model: no key, no account, local. */
  id: "anthropic" | "openai" | "chrome";
  /** Complete a prompt; implementations must not stream. */
  complete(messages: LlmMessage[], opts?: { maxTokens?: number }): Promise<string>;
}

export interface LlmConfig {
  provider: LlmProvider["id"];
  /** Unused by the on-device provider, which needs no credential. */
  apiKey: string;
  model: string;
}

// ---------------------------------------------------------------------------
// Message protocol (side panel ⇄ background ⇄ content).
// ---------------------------------------------------------------------------

/** Discriminated union of every runtime message. Exhaustive by design. */
export type Message =
  | { type: "DETECT_REQUEST"; tabId: number }
  | { type: "DETECT_RESULT"; tabId: number; adapterId: string | null; jobTitle?: string }
  | { type: "DISCOVER_REQUEST"; tabId: number }
  | {
      type: "DISCOVER_RESULT";
      tabId: number;
      fields: FormField[];
      /**
       * Present when no adapter claimed the page: the numbered control list a
       * model classifies instead (discovery/survey.ts). Never carries anything
       * the model may act on directly.
       */
      survey?: PageSurvey;
    }
  | { type: "PLAN_READY"; plan: FillPlan }
  | { type: "INTAKE_ANSWER"; fieldId: string; value: string; saveToQaBank: boolean }
  | { type: "EXECUTE_PLAN"; tabId: number; plan: FillPlan }
  | { type: "FILL_REPORT"; tabId: number; report: FillReport }
  | { type: "APPROVE_SUBMIT"; tabId: number }
  | { type: "SUBMIT_RESULT"; tabId: number; result: SubmitResult }
  | { type: "RUN_STATE"; record: ApplicationRecord }
  | { type: "HUMAN_NEEDED"; tabId: number; reason: "login" | "captcha" | "unknown_page" | "register_offer"; detail: string }
  | { type: "REGISTER_APPROVE"; tabId: number }
  | { type: "REGISTER_FILL"; tabId: number; origin: string; mode: "login" | "registration"; email: string; password: string; firstName?: string; lastName?: string }
  | { type: "REGISTER_RESULT"; tabId: number; ok: boolean; evidence: string }
  | { type: "QUEUE_LINK"; url: string }
  | { type: "QUEUE_REMOVE"; jobId: string }
  | { type: "QUEUE_STATE"; jobs: QueuedJob[] }
  | { type: "REFINE_RESUME_REQUEST"; parsed: ParsedResume }
  | {
      type: "REFINE_RESUME_RESULT";
      /** The refined parse, or the one sent in when refinement did not happen. */
      parsed: ParsedResume;
      /** False when no provider is configured or the attempt failed. */
      refined: boolean;
      /** Why refinement was skipped; unset on success. */
      note?: string;
    };

/** Narrow a Message by type with full inference. */
export function isMessage<T extends Message["type"]>(
  msg: Message,
  type: T,
): msg is Extract<Message, { type: T }> {
  return msg.type === type;
}
