import { useEffect, useState } from "preact/hooks";
import type { ApplicationRecord } from "@larpmaxer/core";
import { buildLedgerXlsx, ledgerRowsFromRecords } from "@larpmaxer/core";
import { getRecords } from "../../background/storage";

// Mirrors KEY_RECORDS in background/storage.ts; storage change events carry raw keys.
const RECORDS_KEY = "records";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** History tab: every stored ApplicationRecord, live-updated, newest first. */
export function HistoryView() {
  const [records, setRecords] = useState<ApplicationRecord[] | null>(null);

  useEffect(() => {
    void getRecords().then(setRecords);
    const onChanged = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ): void => {
      const change = changes[RECORDS_KEY];
      if (area === "local" && change) {
        setRecords((change.newValue as ApplicationRecord[] | undefined) ?? []);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  if (records === null) return <p class="muted">Loading...</p>;
  if (records.length === 0) {
    return <p class="display">Nothing sent <strong>yet</strong>.</p>;
  }

  const downloadLedger = (): void => {
    const xlsx = buildLedgerXlsx(ledgerRowsFromRecords(records));
    const url = URL.createObjectURL(
      new Blob([xlsx.buffer as ArrayBuffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
    void chrome.downloads
      .download({ url, filename: "LarpMaxer/ledger.xlsx", conflictAction: "overwrite" })
      .finally(() => URL.revokeObjectURL(url));
  };

  // ISO timestamps sort lexically; records still in flight float to the top.
  const sorted = [...records].sort((a, b) =>
    (b.submittedAt ?? "9999").localeCompare(a.submittedAt ?? "9999"),
  );

  return (
    <div class="stack">
      <div class="row">
        <button class="btn" onClick={downloadLedger}>
          Download ledger (.xlsx)
        </button>
      </div>
      {sorted.map((r) => (
        <div key={r.id} class="history-item">
          <div class="row">
            <strong>{r.company ?? hostOf(r.url)}</strong>
            <span class={`badge phase-${r.phase}`}>{r.phase.replace("_", " ")}</span>
          </div>
          {r.jobTitle && <div class="small">{r.jobTitle}</div>}
          <div class="row small muted">
            {r.submittedAt && (
              <span>Submitted {new Date(r.submittedAt).toLocaleString()}</span>
            )}
            <a href={r.url} target="_blank" rel="noreferrer">
              {hostOf(r.url)}
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}
