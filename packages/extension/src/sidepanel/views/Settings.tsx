import { useEffect, useState } from "preact/hooks";
import {
  chromeAiAvailability,
  downloadOnDeviceModel,
  DEFAULT_MODELS,
  type ChromeAiAvailability,
} from "@larpmaxer/core";
import type { AutonomyMode, LlmConfig, LlmProvider } from "@larpmaxer/core";
import { getSettings, setSettings, type Settings } from "../../background/storage";

/** "off" is a real choice now that the default provider needs no key. */
type ProviderChoice = LlmProvider["id"] | "off";

const PROVIDERS: readonly ProviderChoice[] = ["chrome", "anthropic", "openai", "off"];
const PROVIDER_LABELS: Record<ProviderChoice, string> = {
  chrome: "Chrome built-in AI (no key needed)",
  anthropic: "Anthropic",
  openai: "OpenAI",
  off: "No model — I'll answer everything myself",
};

/** What each availability state means, in the user's terms. */
const AI_STATE_TEXT: Record<ChromeAiAvailability, string> = {
  available: "Ready — running on your device, no key needed.",
  downloadable: "Supported by this machine. The model needs a one-time download before it can answer.",
  downloading: "Downloading now. This tab can be closed; it continues in the background.",
  unavailable:
    "Not available on this device. Questions it would have answered come to you instead, or add an API key below.",
};

const defaultModel = (p: ProviderChoice): string => (p === "off" ? "" : DEFAULT_MODELS[p]);

// The Message union has no key-test type, so the probe calls the provider
// directly from the panel. Needs host permissions for both API origins.
// The on-device model has no key to test — its state comes from
// chromeAiAvailability instead.
async function probeKey(cfg: LlmConfig): Promise<string> {
  try {
    if (cfg.provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (res.ok) return "Key works.";
      if (res.status === 401 || res.status === 403) return "Invalid API key.";
      return `Provider replied ${res.status} - check the key and model name.`;
    }
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
    });
    if (res.ok) return "Key works.";
    if (res.status === 401 || res.status === 403) return "Invalid API key.";
    return `Provider replied ${res.status} - check the key.`;
  } catch (err) {
    return `Request failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Vanishing lavender seal shown when Auto-submit is chosen. Decoration only. */
function VibeStamp() {
  return (
    <div class="vibe-overlay" aria-hidden="true">
      <div class="vibe-banner">
        Certified <em>Vibe Maxer</em>
      </div>
      <svg class="vibe-stamp" viewBox="0 0 240 240">
        <defs>
          <path id="vibe-top" d="M 37 120 A 83 83 0 0 1 203 120" />
          <path id="vibe-bottom" d="M 27 120 A 93 93 0 0 0 213 120" />
        </defs>
        <circle class="vibe-ring" cx="120" cy="120" r="112" stroke-width="4" />
        <circle class="vibe-ring" cx="120" cy="120" r="104" stroke-width="1.5" />
        <circle class="vibe-ring" cx="120" cy="120" r="72" stroke-width="2" />
        <text font-size="13" letter-spacing="1.5">
          <textPath href="#vibe-top" startOffset="50%" text-anchor="middle">
            ✦ APPROVED BY THE EMPEROR ✦
          </textPath>
        </text>
        <text font-size="13" letter-spacing="2">
          <textPath href="#vibe-bottom" startOffset="50%" text-anchor="middle">
            ★ OF VIBE CODING ★
          </textPath>
        </text>
        <text x="120" y="98" text-anchor="middle" font-size="15" letter-spacing="2.5">CERTIFIED</text>
        <text x="120" y="127" text-anchor="middle" font-size="27" font-weight="700" letter-spacing="1">VIBE</text>
        <text x="120" y="155" text-anchor="middle" font-size="27" font-weight="700" letter-spacing="1">MAXER</text>
        <text x="120" y="76" text-anchor="middle" font-size="11" letter-spacing="1">★ ★ ★</text>
        <text x="120" y="178" text-anchor="middle" font-size="11" letter-spacing="1">★ ★ ★</text>
      </svg>
    </div>
  );
}

/** Settings tab: autonomy mode, LLM provider/model, and a locally stored API key. */
export function SettingsView() {
  // The on-device model is the default: it is the only one that works with no
  // setup at all, which is the point of shipping with it.
  const [provider, setProvider] = useState<ProviderChoice>("chrome");
  const [model, setModel] = useState<string>(() => defaultModel("chrome"));
  const [aiState, setAiState] = useState<ChromeAiAvailability | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [autonomy, setAutonomy] = useState<AutonomyMode>("review");
  const [saveArtifacts, setSaveArtifacts] = useState(true);
  const [autoRegister, setAutoRegister] = useState(true);
  const [flash, setFlash] = useState("");
  const [vibe, setVibe] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState("");

  useEffect(() => {
    void getSettings().then((s) => {
      setAutonomy(s.autonomy);
      setSaveArtifacts(s.saveArtifacts !== false);
      setAutoRegister(s.autoRegister !== false);
      if (s.llmOff === true) {
        setProvider("off");
      } else if (s.llm) {
        setProvider(s.llm.provider);
        setModel(s.llm.model);
        setApiKey(s.llm.apiKey);
      }
    });
  }, []);

  // Probe on open so the on-device state is visible without pressing anything.
  // The probe has its own deadline, so a wedged API cannot stall this tab.
  useEffect(() => {
    if (provider !== "chrome") return;
    void chromeAiAvailability().then(setAiState);
  }, [provider]);

  /**
   * Fetch the weights, driven by this click.
   *
   * It runs in the panel rather than the background worker on purpose: it
   * needs a user gesture, it is the browser's own model rather than a keyed
   * provider, and the progress has somewhere to be shown.
   */
  const download = async (): Promise<void> => {
    setDownloading(true);
    setProgress(0);
    setTestMsg("");
    const state = await downloadOnDeviceModel(setProgress);
    setAiState(state);
    setDownloading(false);
    setTestMsg(
      state === "available"
        ? "Downloaded. LarpMaxer will answer with the on-device model from now on."
        : `Download did not complete — ${AI_STATE_TEXT[state]}`,
    );
  };

  const onProvider = (next: ProviderChoice): void => {
    // Only replace the model if the user never customised it.
    if (model.trim() === "" || model === defaultModel(provider)) {
      setModel(defaultModel(next));
    }
    setProvider(next);
    setTestMsg("");
  };

  const save = async (): Promise<void> => {
    const base = { autonomy, saveArtifacts, autoRegister };
    // "off" is now the only way to have no model: an empty key no longer
    // doubles as one, because the default provider never needed a key.
    // A cloud provider without a key is inert, so it falls back to on-device
    // rather than silently answering nothing.
    const next: Settings =
      provider === "off"
        ? { ...base, llmOff: true }
        : provider === "chrome" || apiKey.trim() !== ""
          ? { ...base, llm: { provider, apiKey, model } }
          : { ...base, llm: { provider: "chrome", apiKey: "", model: "" } };
    await setSettings(next);
    setFlash(
      provider !== "off" && provider !== "chrome" && apiKey.trim() === ""
        ? "Saved — no key, so the on-device model is used"
        : "Saved",
    );
    window.setTimeout(() => setFlash(""), 2500);
  };

  const test = async (): Promise<void> => {
    if (provider === "off") return;
    setTesting(true);
    setTestMsg("");
    if (provider === "chrome") {
      const state = await chromeAiAvailability();
      setAiState(state);
      setTestMsg(AI_STATE_TEXT[state]);
    } else {
      const probeModel = model.trim() === "" ? defaultModel(provider) : model;
      setTestMsg(await probeKey({ provider, apiKey, model: probeModel }));
    }
    setTesting(false);
  };

  return (
    <div class="stack">
      {vibe && <VibeStamp />}
      <h2>Autonomy</h2>
      <label class="check">
        <input
          type="radio"
          name="autonomy"
          checked={autonomy === "review"}
          onChange={() => setAutonomy("review")}
        />
        Review first (recommended) — see the form before it's sent
      </label>
      <label class="check">
        <input
          type="radio"
          name="autonomy"
          checked={autonomy === "auto"}
          onChange={() => {
            setAutonomy("auto");
            // Easter egg: full autonomy earns the imperial seal. Purely visual.
            setVibe(true);
            window.setTimeout(() => setVibe(false), 3100);
          }}
        />
        Auto-submit
      </label>
      {autonomy === "auto" && (
        <p class="warn">
          Submits without showing the review card. Every run is still recorded.
        </p>
      )}

      <h2>Artifacts</h2>
      <label class="check">
        <input
          type="checkbox"
          checked={saveArtifacts}
          onChange={(e) => setSaveArtifacts(e.currentTarget.checked)}
        />
        Save a folder per application + ledger.xlsx to Downloads/LarpMaxer
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={autoRegister}
          onChange={(e) => setAutoRegister(e.currentTarget.checked)}
        />
        Create portal accounts for me (asks once per site, password saved to this browser)
      </label>

      <h2>LLM provider</h2>
      <label class="field">
        <span>Provider</span>
        <select
          value={provider}
          onChange={(e) => onProvider(e.currentTarget.value as LlmProvider["id"])}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      {provider === "chrome" && (
        <div class={aiState === "unavailable" ? "card" : "card intake"}>
          <strong class="card-title">On-device model</strong>
          <p class="small">{aiState === null ? "Checking this device..." : AI_STATE_TEXT[aiState]}</p>
          {downloading && (
            <p class="small">
              Downloading... {Math.round(progress * 100)}%
              <span class="bar" aria-hidden="true">
                <span class="bar-fill" style={`width:${Math.round(progress * 100)}%`} />
              </span>
            </p>
          )}
          {(aiState === "downloadable" || aiState === "downloading") && (
            <div class="row">
              <button class="btn primary" disabled={downloading} onClick={() => void download()}>
                {downloading ? "Downloading..." : "Download the model"}
              </button>
            </div>
          )}
          {aiState === "unavailable" && (
            <p class="muted small">
              Nothing is broken — LarpMaxer still fills everything it can read from your profile,
              and asks you the rest instead of guessing.
            </p>
          )}
        </div>
      )}
      {provider !== "chrome" && provider !== "off" && (
      <label class="field">
        <span>Model</span>
        <input
          type="text"
          value={model}
          placeholder={defaultModel(provider)}
          onInput={(e) => setModel(e.currentTarget.value)}
        />
      </label>
      )}
      {provider !== "chrome" && provider !== "off" && (
      <label class="field">
        <span>API key</span>
        <input
          type="password"
          value={apiKey}
          placeholder="sk-..."
          autocomplete="off"
          onInput={(e) => setApiKey(e.currentTarget.value)}
        />
      </label>
      )}
      <p class="muted small">
        {provider === "chrome"
          ? "Runs on your machine using the model built into Chrome. No key, no account, no cost — and nothing leaves your device."
          : provider === "off"
            ? "Every question LarpMaxer cannot answer from your profile or your saved answers comes to you. Nothing is sent to any model."
            : "Stays in this browser, sent only to your chosen provider. Leave it empty to fall back to the on-device model."}
      </p>

      <div class="row">
        <button class="btn primary" onClick={() => void save()}>
          Save settings
        </button>
        {provider !== "off" && (
          <button
            class="btn"
            disabled={(provider !== "chrome" && apiKey.trim() === "") || testing}
            onClick={() => void test()}
          >
            {testing ? "Checking..." : provider === "chrome" ? "Re-check" : "Test key"}
          </button>
        )}
        {flash !== "" && <span class="flash">{flash}</span>}
      </div>
      {testMsg !== "" && (
        <p class={testMsg === "Key works." ? "small ok-text" : "small warn"}>{testMsg}</p>
      )}
    </div>
  );
}
