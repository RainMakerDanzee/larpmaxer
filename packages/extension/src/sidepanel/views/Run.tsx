import { useEffect, useState } from "preact/hooks";
import type {
  ApplicationRecord,
  FillPlan,
  FillReport,
  Message,
  OpenQuestion,
  QueuedJob,
  ResolvedAnswer,
} from "@larpmaxer/core";
import { sendToRuntime } from "../../lib/messaging";

/** Detection summary from the latest DETECT_RESULT for the current tab. */
export type DetectState = Pick<
  Extract<Message, { type: "DETECT_RESULT" }>,
  "adapterId" | "jobTitle"
>;

/** A pending "your turn" interruption from a HUMAN_NEEDED message. */
export type HumanNeeded = Pick<
  Extract<Message, { type: "HUMAN_NEEDED" }>,
  "reason" | "detail"
>;

/** Props for {@link RunView}; all live state is owned by the message hub in main.tsx. */
export interface RunProps {
  record: ApplicationRecord | null;
  plan: FillPlan | null;
  report: FillReport | null;
  detect: DetectState | null;
  human: HumanNeeded | null;
  /** Tab the background last messaged about; null before any message arrives. */
  tabId: number | null;
  /** Dropped-link queue, newest first. */
  queue: QueuedJob[];
  /** Clears the human-needed card once the user clicks Continue. */
  onHumanDone: () => void;
}

/**
 * Where an answer came from, in the user's words.
 *
 * The product's central claim is that every answer traces to something the
 * user owns. The review card is where that claim is checked, so it says the
 * provenance of each value rather than asking anyone to take it on trust.
 */
const SOURCE_LABEL: Record<ResolvedAnswer["source"], string> = {
  profile: "from your profile",
  qa_bank: "from your saved answers",
  llm: "drafted from your profile",
  user: "you typed",
};

/** Short form for the per-row chip, where space is tight. */
const SOURCE_SHORT: Record<ResolvedAnswer["source"], string> = {
  profile: "profile",
  qa_bank: "saved",
  llm: "drafted",
  user: "typed",
};

const STATUS_LABEL: Record<QueuedJob["status"], string> = {
  queued: "Queued",
  opening: "Opening",
  running: "Filling",
  awaiting_user: "Needs you",
  review: "Review ready",
  sent: "Sent",
  unsupported: "Apply manually",
  error: "Failed",
};

/** Paste-a-link hero + per-job cards. The product's front door. */
function LinkQueue(props: { queue: QueuedJob[] }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");

  const add = async (): Promise<void> => {
    let origin: string;
    try {
      origin = new URL(url.trim().startsWith("http") ? url.trim() : `https://${url.trim()}`).origin;
    } catch {
      setErr("That doesn't look like a link.");
      return;
    }
    setErr("");
    // This click IS the user gesture — grab host access now; the background
    // worker tab has no gesture to ask with.
    await chrome.permissions
      .request({ origins: [`${origin}/*`] })
      .catch(() => undefined);
    send({ type: "QUEUE_LINK", url: url.trim() });
    setUrl("");
  };

  return (
    <div class="stack">
      <p class="display">
        Apply to <strong>anything</strong><em>.</em>
      </p>
      <div class="row link-row">
        <input
          type="url"
          value={url}
          placeholder="Paste a job link"
          onInput={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim() !== "") void add();
          }}
        />
        <button class="btn primary" disabled={url.trim() === ""} onClick={() => void add()}>
          Apply
        </button>
      </div>
      {err !== "" && <p class="muted small">{err}</p>}
      {props.queue.length > 0 && (
        <div class="stack">
          {props.queue.map((j) => (
            <div key={j.id} class={`card queue-card status-${j.status}`}>
              <div class="row">
                <span class={`status-dot status-${j.status}`} aria-hidden="true" />
                <span class="queue-status">{STATUS_LABEL[j.status]}</span>
                <span class="queue-host muted small">{hostOf(j.url)}</span>
              </div>
              <div class="card-title">{j.jobTitle ?? j.url.replace(/^https:\/\//, "").slice(0, 60)}</div>
              {j.note !== undefined && <p class="muted small">{j.note}</p>}
              <div class="row">
                {j.tabId !== undefined && (
                  <button
                    class="btn"
                    onClick={() => void chrome.tabs.update(j.tabId!, { active: true })}
                  >
                    Open tab
                  </button>
                )}
                <button class="btn" onClick={() => send({ type: "QUEUE_REMOVE", jobId: j.id })}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const HUMAN_ACTION: Record<HumanNeeded["reason"], string> = {
  login: "Log in",
  captcha: "Solve the CAPTCHA",
  unknown_page: "Check the page",
  register_offer: "New portal",
};

function send(msg: Message): void {
  // Fire-and-forget: a sleeping background worker just means the user retries.
  void sendToRuntime(msg).catch(() => undefined);
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/** One open intake question: answer input, save-to-answers toggle, Answer button. */
function IntakeCard(props: {
  q: OpenQuestion;
  onAnswer: (value: string, save: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [save, setSave] = useState(true);
  return (
    <div class="card intake">
      <div class="card-title">{props.q.label}</div>
      <p class="muted small">{props.q.reason}</p>
      {props.q.options ? (
        <select value={value} onChange={(e) => setValue(e.currentTarget.value)}>
          <option value="" disabled>
            Choose an option
          </option>
          {props.q.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          placeholder="Your answer"
          onInput={(e) => setValue(e.currentTarget.value)}
        />
      )}
      <label class="check">
        <input
          type="checkbox"
          checked={save}
          onChange={(e) => setSave(e.currentTarget.checked)}
        />
        Save to my answers for next time
      </label>
      <div class="row">
        <button
          class="btn primary"
          disabled={value.trim() === ""}
          onClick={() => props.onAnswer(value.trim(), save)}
        >
          Answer
        </button>
      </div>
    </div>
  );
}

/** Run tab: detection state, Scan/Fill controls, intake queue, review artifact, human-needed card. */
export function RunView(props: RunProps) {
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = useState(false);
  /**
   * Field ids this form asked about that the run could not answer itself,
   * keyed by the form they belong to. Keyed rather than reset on the run id,
   * because the id arrives after the plan does — resetting on it wiped the
   * tally the instant the run announced itself.
   */
  const [asked, setAsked] = useState<{ url: string; ids: ReadonlySet<string> }>({
    url: "",
    ids: new Set(),
  });

  async function scan(): Promise<void> {
    const id = await activeTabId();
    if (id !== null) send({ type: "DETECT_REQUEST", tabId: id });
  }

  async function targetTab(): Promise<number | null> {
    return props.tabId ?? (await activeTabId());
  }

  async function fill(): Promise<void> {
    if (!props.plan) return;
    const id = await targetTab();
    if (id !== null) send({ type: "EXECUTE_PLAN", tabId: id, plan: props.plan });
  }

  async function approve(): Promise<void> {
    const id = await targetTab();
    if (id !== null) send({ type: "APPROVE_SUBMIT", tabId: id });
  }

  async function continueAfterHuman(): Promise<void> {
    props.onHumanDone();
    // The protocol has no dedicated resume message; re-detecting restarts the
    // pipeline against the now-unblocked page.
    await scan();
  }

  // A fresh plan means the background re-resolved; optimistic hiding resets.
  useEffect(() => {
    setAnswered(new Set());
  }, [props.plan]);

  // Every question this form asked that the run could not answer. It has to
  // accumulate: the background removes each one from needsUser as it is
  // answered, so the live list is not what the run actually learned.
  useEffect(() => {
    const plan = props.plan;
    if (plan === null) return;
    setAsked((prev) => {
      const ids = new Set(prev.url === plan.url ? prev.ids : []);
      for (const q of plan.needsUser) ids.add(q.fieldId);
      return { url: plan.url, ids };
    });
  }, [props.plan]);

  // A new run or phase change voids any local review dismissal.
  useEffect(() => {
    setDismissed(false);
  }, [props.record?.id, props.record?.phase]);

  // Detect as soon as the panel opens so the tab state shows immediately,
  // and pull the current link queue.
  useEffect(() => {
    void scan();
    send({ type: "QUEUE_STATE", jobs: [] }); // ping — background replies with the real state
  }, []);

  const openQuestions = (props.plan?.needsUser ?? []).filter(
    (q) => !answered.has(q.fieldId),
  );

  const answerIntake = (q: OpenQuestion, value: string, save: boolean): void => {
    send({ type: "INTAKE_ANSWER", fieldId: q.fieldId, value, saveToQaBank: save });
    setAnswered((prev) => new Set([...prev, q.fieldId]));
  };

  const report = props.report ?? props.record?.report ?? null;
  const askedCount = asked.ids.size;
  const showReview = props.record?.phase === "review" && !dismissed;
  // The report knows what landed on the page; the plan knows where each value
  // came from. Neither alone can answer "is this true?", so they are joined.
  const sourceOf = new Map(
    (props.plan?.answers ?? []).map((a) => [a.fieldId, a.source] as const),
  );
  const reviewRows: {
    label: string;
    value: string;
    source?: ResolvedAnswer["source"];
  }[] = report
    ? report.fields.map((f) => ({
        label: f.label,
        value:
          f.finalValue ??
          (f.error !== undefined ? `${f.outcome}: ${f.error}` : f.outcome),
        ...(sourceOf.has(f.fieldId) ? { source: sourceOf.get(f.fieldId)! } : {}),
      }))
    : (props.plan?.answers ?? []).map((a) => ({
        label: a.fieldId,
        value: String(a.value),
        source: a.source,
      }));

  // One line of provenance for the whole form, so the common case needs no
  // row-by-row reading.
  const bySource = new Map<ResolvedAnswer["source"], number>();
  for (const row of reviewRows) {
    if (row.source === undefined) continue;
    bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1);
  }
  const provenance = [...bySource.entries()]
    .map(([source, n]) => `${n} ${SOURCE_LABEL[source]}`)
    .join(", ");
  const resume = props.plan?.answers.find((a) => a.resume !== undefined)?.resume;
  const submit = props.record?.submit;

  return (
    <div class="stack">
      <LinkQueue queue={props.queue} />
      {props.human && props.human.reason === "register_offer" && (
        <section class="card human">
          <div class="card-title">New portal</div>
          <p class="small">
            <strong>{props.human.detail.replace(/^https:\/\//, "")}</strong> needs an account.
            Create one with your profile email and a generated password? Saved to this
            browser — you'll never be asked about this site again.
          </p>
          <div class="row">
            <button
              class="btn primary"
              onClick={() => {
                if (props.tabId !== null) {
                  send({ type: "REGISTER_APPROVE", tabId: props.tabId });
                }
                props.onHumanDone();
              }}
            >
              Create account
            </button>
            <button class="btn" onClick={() => props.onHumanDone()}>
              I'll do it myself
            </button>
          </div>
        </section>
      )}
      {props.human && props.human.reason !== "register_offer" && (
        <section class="card human">
          <div class="card-title">Your turn</div>
          <p class="small">{HUMAN_ACTION[props.human.reason]}, then continue.</p>
          {props.human.detail !== "" && (
            <p class="muted small">{props.human.detail}</p>
          )}
          <div class="row">
            <button class="btn primary" onClick={() => void continueAfterHuman()}>
              Continue
            </button>
          </div>
        </section>
      )}

      <section class="card">
        <div class="row">
          <div class="card-title">This tab</div>
          {props.record && (
            <span class={`badge phase-${props.record.phase}`}>
              {props.record.phase.replace("_", " ")}
            </span>
          )}
        </div>
        {props.detect === null ? (
          <p class="muted small">Open a job posting, then Scan.</p>
        ) : props.detect.adapterId === null ? (
          <p class="muted small">No form detected here.</p>
        ) : (
          <p class="small">
            Fillable: <strong>{props.detect.adapterId}</strong>
            {props.detect.jobTitle ? ` — ${props.detect.jobTitle}` : ""}
          </p>
        )}
        <div class="row">
          <button class="btn" onClick={() => void scan()}>
            Scan page
          </button>
          <button
            class="btn primary"
            disabled={!props.plan || props.plan.needsUser.length > 0}
            onClick={() => void fill()}
          >
            Fill
          </button>
          {props.plan && props.plan.needsUser.length > 0 && (
            <span class="muted small">
              answer {props.plan.needsUser.length} below first
            </span>
          )}
        </div>
        {props.plan && props.plan.needsUser.length === 0 && (
          <p class="muted small">{props.plan.answers.length} fields ready.</p>
        )}
      </section>

      {openQuestions.length > 0 && (
        <section class="stack">
          <h2>Needs you ({openQuestions.length})</h2>
          {openQuestions.map((q) => (
            <IntakeCard
              key={q.fieldId}
              q={q}
              onAnswer={(v, s) => answerIntake(q, v, s)}
            />
          ))}
        </section>
      )}

      {showReview && (
        <section class="card review">
          <div class="card-title">Review before submit</div>
          {resume && (
            <p class="small">
              Resume: <strong>{resume.filename}</strong>
            </p>
          )}
          {provenance !== "" && <p class="small">Every value: {provenance}.</p>}
          <div class="table-wrap">
            <table class="kv">
              <tbody>
                {reviewRows.map((r, i) => (
                  <tr key={i}>
                    <th>{r.label}</th>
                    <td>
                      {r.value}
                      {r.source !== undefined && (
                        <span class="src">{SOURCE_SHORT[r.source]}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {askedCount > 0 && (
            <p class="muted small">
              Learned {askedCount} new question{askedCount === 1 ? "" : "s"} on this form. They
              are in your Q&amp;A bank under Profile — answer them once and the next form that
              asks fills itself.
            </p>
          )}
          <div class="row">
            <button class="btn primary" onClick={() => void approve()}>
              Approve &amp; Submit
            </button>
            <button class="btn" onClick={() => setDismissed(true)}>
              Cancel
            </button>
          </div>
          <p class="muted small">
            Cancel sends nothing. Scan again to rebuild.
          </p>
        </section>
      )}

      {props.record?.phase === "done" && submit?.submitted === true && (
        <section class="card">
          <div class="card-title">Submitted</div>
          {submit.evidence.map((line, i) => (
            <p key={i} class="muted small">
              {line}
            </p>
          ))}
        </section>
      )}

      {props.record?.phase === "error" && (
        <section class="card">
          <div class="card-title">Run failed</div>
          {(submit?.evidence ?? []).map((line, i) => (
            <p key={i} class="muted small">
              {line}
            </p>
          ))}
          <p class="muted small">Check the page, then scan again.</p>
        </section>
      )}
    </div>
  );
}
