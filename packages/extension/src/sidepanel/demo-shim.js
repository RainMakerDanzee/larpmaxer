/**
 * Demo shim: runs the real side-panel UI in an ordinary browser tab.
 *
 * The panel talks to Chrome (storage, runtime messaging, tabs, downloads).
 * This file provides just enough of those APIs, backed by localStorage and a
 * scripted fake background worker, so the actual Preact app — not a mock —
 * can be clicked through and critiqued. Loaded ONLY by demo.html.
 */
(() => {
  const KEY = "larpmaxer-demo";
  const store = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  const persist = () => localStorage.setItem(KEY, JSON.stringify(store));
  const listeners = [];
  const changeListeners = [];

  const emit = (msg) => {
    // Async, like the real runtime, so React state settles between hops.
    setTimeout(() => listeners.forEach((fn) => fn(msg, { id: "larpmaxer-demo" }, () => {})), 60);
  };

  // ---- seeded demo data ---------------------------------------------------
  if (!store.queue) {
    store.queue = [
      { id: "q1", url: "https://boards.greenhouse.io/acme/jobs/1", jobTitle: "Product Analyst — Acme", status: "running", addedAt: new Date().toISOString() },
      { id: "q2", url: "https://jobs.lever.co/example/2", jobTitle: "Data Analyst — Example Co", status: "review", addedAt: new Date().toISOString() },
      { id: "q3", url: "https://jobs.ashbyhq.com/example/3", jobTitle: "Automation Analyst — Sample Inc", status: "sent", addedAt: new Date().toISOString() },
    ];
  }
  if (!store.records) {
    store.records = [
      { id: "r1", url: "https://jobs.ashbyhq.com/example/3", company: "Sample Inc", jobTitle: "Automation Analyst", adapterId: "ashby", phase: "done", submittedAt: "2026-01-15T11:20:00.000Z", submit: { submitted: true, evidence: ["Your application was successfully submitted."] } },
      { id: "r2", url: "https://boards.greenhouse.io/acme/jobs/1", company: "Acme", jobTitle: "Product Analyst", adapterId: "greenhouse", phase: "done", submittedAt: "2026-01-14T21:05:00.000Z", submit: { submitted: true, evidence: ["Thank you for applying"] } },
      { id: "r3", url: "https://jobs.lever.co/example/2", company: "Example Co", jobTitle: "Data Analyst", adapterId: "lever", phase: "done", submittedAt: "2026-01-12T16:20:00.000Z", submit: { submitted: true, evidence: ["Your application has been sent"] } },
    ];
  }
  persist();

  // ---- chrome API surface -------------------------------------------------
  window.chrome = {
    runtime: {
      id: "larpmaxer-demo",
      lastError: undefined,
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const i = listeners.indexOf(fn);
          if (i > -1) listeners.splice(i, 1);
        },
      },
      sendMessage: async (msg) => {
        handle(msg);
        return undefined;
      },
    },
    storage: {
      local: {
        get: async (key) => {
          if (key === null || key === undefined) return { ...store };
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.map((k) => [k, store[k]]));
        },
        set: async (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          persist();
          changeListeners.forEach((fn) => fn(changes, "local"));
        },
        remove: async (key) => {
          delete store[key];
          persist();
        },
      },
      onChanged: {
        addListener: (fn) => changeListeners.push(fn),
        removeListener: (fn) => {
          const i = changeListeners.indexOf(fn);
          if (i > -1) changeListeners.splice(i, 1);
        },
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: "https://boards.greenhouse.io/demo/jobs/123", title: "Demo job posting" }],
      get: async (id) => ({ id, url: "https://boards.greenhouse.io/demo/jobs/123", status: "complete" }),
      create: async () => ({ id: Math.floor(Math.random() * 1000) }),
      update: async () => {
        alert("In the real extension this focuses the job's tab.");
      },
      remove: async () => {},
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
    permissions: {
      contains: async () => true,
      request: async () => true,
    },
    downloads: {
      download: async ({ filename }) => {
        alert(`The real extension saves:\n\nDownloads/${filename}`);
        return 1;
      },
    },
    scripting: { executeScript: async () => [] },
    sidePanel: { setPanelBehavior: async () => {} },
  };

  // ---- scripted background ------------------------------------------------
  function handle(msg) {
    switch (msg.type) {
      case "QUEUE_STATE":
        emit({ type: "QUEUE_STATE", jobs: store.queue });
        break;

      case "QUEUE_LINK": {
        const job = {
          id: `q${Date.now()}`,
          url: msg.url,
          status: "opening",
          addedAt: new Date().toISOString(),
        };
        store.queue = [job, ...store.queue];
        persist();
        emit({ type: "QUEUE_STATE", jobs: store.queue });
        // Narrate a believable run so the states can be judged in motion.
        const steps = [
          [900, "running", { jobTitle: "Senior Data Analyst", adapterId: "greenhouse" }],
          [2600, "awaiting_user", {}],
          [5200, "review", {}],
        ];
        steps.forEach(([ms, status, extra]) => {
          setTimeout(() => {
            const j = store.queue.find((q) => q.id === job.id);
            if (!j) return;
            Object.assign(j, extra, { status });
            persist();
            emit({ type: "QUEUE_STATE", jobs: store.queue });
            if (status === "awaiting_user") {
              emit({ type: "HUMAN_NEEDED", tabId: 1, reason: "register_offer", detail: new URL(msg.url.startsWith("http") ? msg.url : `https://${msg.url}`).origin });
            }
            if (status === "review") {
              emit({ type: "RUN_STATE", record: { id: job.id, url: msg.url, adapterId: "greenhouse", jobTitle: j.jobTitle, phase: "review" } });
              emit({
                type: "FILL_REPORT",
                tabId: 1,
                report: {
                  url: msg.url,
                  adapterId: "greenhouse",
                  complete: true,
                  fields: [
                    { fieldId: "name", label: "Full name", outcome: "verified", finalValue: "Riley Park" },
                    { fieldId: "email", label: "Email", outcome: "verified", finalValue: "riley.park@example.com" },
                    { fieldId: "phone", label: "Phone", outcome: "verified", finalValue: "+61 400 000 000" },
                    { fieldId: "loc", label: "Location", outcome: "verified", finalValue: "Sydney, New South Wales, Australia" },
                    { fieldId: "spon", label: "Require sponsorship?", outcome: "verified", finalValue: "No" },
                    { fieldId: "resume", label: "Resume", outcome: "verified", finalValue: "Riley_Park_CV.pdf" },
                  ],
                },
              });
            }
          }, ms);
        });
        break;
      }

      case "QUEUE_REMOVE":
        store.queue = store.queue.filter((q) => q.id !== msg.jobId);
        persist();
        emit({ type: "QUEUE_STATE", jobs: store.queue });
        break;

      case "DETECT_REQUEST":
        emit({ type: "DETECT_RESULT", tabId: 1, adapterId: "greenhouse", jobTitle: "Senior Data Analyst (demo page)" });
        setTimeout(() => {
          emit({
            type: "PLAN_READY",
            plan: {
              adapterId: "greenhouse",
              url: "https://boards.greenhouse.io/demo/jobs/123",
              answers: [
                { fieldId: "name", value: "Riley Park", source: "profile" },
                { fieldId: "email", value: "riley.park@example.com", source: "profile" },
              ],
              needsUser: [
                { fieldId: "salary", label: "What are your salary expectations?", reason: "Not in your profile.", options: undefined },
                { fieldId: "start", label: "Earliest start date?", reason: "Not in your profile.", options: ["Immediately", "2 weeks", "1 month"] },
              ],
            },
          });
          emit({ type: "RUN_STATE", record: { id: "demo", url: "https://boards.greenhouse.io/demo/jobs/123", adapterId: "greenhouse", phase: "awaiting_user" } });
        }, 700);
        break;

      case "REGISTER_APPROVE":
        emit({ type: "RUN_STATE", record: { id: "demo", url: "https://x", adapterId: "greenhouse", phase: "registering" } });
        setTimeout(() => alert("Demo: LarpMaxer would now create the account with a generated password\nand save it to your browser's password manager."), 300);
        break;

      // The real background refines the parse with the user's own model. The
      // demo has no key, so it answers the way that case answers for real:
      // the heuristic parse comes straight back, unrefined.
      case "REFINE_RESUME_REQUEST":
        emit({
          type: "REFINE_RESUME_RESULT",
          parsed: msg.parsed,
          refined: false,
          note: "Demo: no model configured, so this is the rule-based read.",
        });
        break;

      case "INTAKE_ANSWER":
        emit({ type: "RUN_STATE", record: { id: "demo", url: "https://x", adapterId: "greenhouse", phase: "review" } });
        break;

      case "EXECUTE_PLAN":
        emit({ type: "RUN_STATE", record: { id: "demo", url: "https://x", adapterId: "greenhouse", phase: "filling" } });
        break;

      case "APPROVE_SUBMIT":
        emit({
          type: "RUN_STATE",
          record: {
            id: "demo",
            url: "https://boards.greenhouse.io/demo/jobs/123",
            adapterId: "greenhouse",
            jobTitle: "Senior Data Analyst (demo page)",
            phase: "done",
            submittedAt: new Date().toISOString(),
            submit: { submitted: true, evidence: ["Thank you for applying — demo confirmation."] },
          },
        });
        emit({ type: "SUBMIT_RESULT", tabId: 1, result: { submitted: true, evidence: ["Thank you for applying — demo confirmation."] } });
        break;

      default:
        break;
    }
  }

  window.larpmaxerDemoReset = () => {
    localStorage.removeItem(KEY);
    location.reload();
  };
})();
