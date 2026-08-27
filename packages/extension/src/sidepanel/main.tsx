import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
  ApplicationRecord,
  FillPlan,
  FillReport,
  QueuedJob,
} from "@larpmaxer/core";
import { onMessage } from "../lib/messaging";
import { RunView } from "./views/Run";
import type { DetectState, HumanNeeded } from "./views/Run";
import { ProfileView } from "./views/Profile";
import { HistoryView } from "./views/History";
import { SettingsView } from "./views/Settings";

const TABS = ["Run", "Profile", "History", "Settings"] as const;
type Tab = (typeof TABS)[number];

/** Side-panel root: four tabs plus the runtime-message subscription feeding the Run view. */
export function App() {
  const [tab, setTab] = useState<Tab>("Run");
  const [record, setRecord] = useState<ApplicationRecord | null>(null);
  const [plan, setPlan] = useState<FillPlan | null>(null);
  const [report, setReport] = useState<FillReport | null>(null);
  const [detect, setDetect] = useState<DetectState | null>(null);
  const [human, setHuman] = useState<HumanNeeded | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [queue, setQueue] = useState<QueuedJob[]>([]);

  useEffect(() => {
    // onMessage verifies the sender and shape; returns the unsubscriber.
    return onMessage((msg) => {
      switch (msg.type) {
        case "RUN_STATE":
          setRecord(msg.record);
          // A run restarting from the top invalidates the previous artifacts.
          if (msg.record.phase === "detecting" || msg.record.phase === "discovering") {
            setPlan(null);
            setReport(null);
          }
          if (msg.record.report) setReport(msg.record.report);
          if (msg.record.phase !== "awaiting_user") setHuman(null);
          break;
        case "PLAN_READY":
          setPlan(msg.plan);
          break;
        case "DETECT_RESULT":
          setTabId(msg.tabId);
          setDetect({ adapterId: msg.adapterId, jobTitle: msg.jobTitle });
          break;
        case "DISCOVER_RESULT":
          setTabId(msg.tabId);
          break;
        case "FILL_REPORT":
          setTabId(msg.tabId);
          setReport(msg.report);
          break;
        case "SUBMIT_RESULT":
          setTabId(msg.tabId);
          break;
        case "QUEUE_STATE":
          setQueue(msg.jobs);
          break;
        case "HUMAN_NEEDED":
          setTabId(msg.tabId);
          setHuman({ reason: msg.reason, detail: msg.detail });
          break;
        default:
          break;
      }
    });
  }, []);

  return (
    <div class="app">
      <nav class="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            class={tab === t ? "tab active" : "tab"}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
      <div class="view">
        {tab === "Run" && (
          <RunView
            record={record}
            plan={plan}
            report={report}
            detect={detect}
            human={human}
            tabId={tabId}
            queue={queue}
            onHumanDone={() => setHuman(null)}
          />
        )}
        {tab === "Profile" && <ProfileView />}
        {tab === "History" && <HistoryView />}
        {tab === "Settings" && <SettingsView />}
      </div>
    </div>
  );
}

const root = document.getElementById("app");
if (root !== null) render(<App />, root);
