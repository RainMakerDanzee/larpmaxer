import { useEffect, useState } from "preact/hooks";
import { DEFAULT_MODELS } from "@larpmaxer/core";
import type { AutonomyMode, LlmConfig, LlmProvider } from "@larpmaxer/core";
import { getSettings, setSettings, type Settings } from "../../background/storage";

const PROVIDERS: readonly LlmProvider["id"][] = ["anthropic", "openai"];
const PROVIDER_LABELS: Record<LlmProvider["id"], string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const defaultModel = (p: LlmProvider["id"]): string => DEFAULT_MODELS[p];

// The Message union has no key-test type, so the probe calls the provider
// directly from the panel. Needs host permissions for both API origins.
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
          <path id="vibe-top" d="M 22 120 A 98 98 0 0 1 218 120" />
          <path id="vibe-bottom" d="M 34 120 A 86 86 0 0 0 206 120" />
        </defs>
        <circle class="vibe-ring" cx="120" cy="120" r="112" stroke-width="4" />
        <circle class="vibe-ring" cx="120" cy="120" r="104" stroke-width="1.5" />
        <circle class="vibe-ring" cx="120" cy="120" r="72" stroke-width="2" />
        <text font-size="13" letter-spacing="2.5">
          <textPath href="#vibe-top" startOffset="50%" text-anchor="middle">
            ✦ APPROVED BY THE EMPEROR ✦
          </textPath>
        </text>
        <text font-size="13" letter-spacing="3">
          <textPath href="#vibe-bottom" startOffset="50%" text-anchor="middle">
            ★ OF VIBE CODING ★
          </textPath>
        </text>
        <text x="120" y="106" text-anchor="middle" font-size="15" letter-spacing="2">CERTIFIED</text>
        <text x="120" y="130" text-anchor="middle" font-size="22" font-weight="600" letter-spacing="1">VIBE</text>
        <text x="120" y="152" text-anchor="middle" font-size="22" font-weight="600" letter-spacing="1">MAXER</text>
        <text x="120" y="86" text-anchor="middle" font-size="10">★ ★ ★</text>
        <text x="120" y="172" text-anchor="middle" font-size="10">★ ★ ★</text>
      </svg>
    </div>
  );
}

/** Settings tab: autonomy mode, LLM provider/model, and a locally stored API key. */
export function SettingsView() {
  const [provider, setProvider] = useState<LlmProvider["id"]>("anthropic");
  const [model, setModel] = useState<string>(() => defaultModel("anthropic"));
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
      if (s.llm) {
        setProvider(s.llm.provider);
        setModel(s.llm.model);
        setApiKey(s.llm.apiKey);
      }
    });
  }, []);

  const onProvider = (next: LlmProvider["id"]): void => {
    // Only replace the model if the user never customised it.
    if (model.trim() === "" || model === defaultModel(provider)) {
      setModel(defaultModel(next));
    }
    setProvider(next);
  };

  const save = async (): Promise<void> => {
    // No key means LLM answering stays off (Settings.llm unset by contract).
    const next: Settings =
      apiKey.trim() === ""
        ? { autonomy, saveArtifacts, autoRegister }
        : { autonomy, saveArtifacts, autoRegister, llm: { provider, apiKey, model } };
    await setSettings(next);
    setFlash("Saved");
    window.setTimeout(() => setFlash(""), 1500);
  };

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestMsg("");
    const probeModel = model.trim() === "" ? defaultModel(provider) : model;
    setTestMsg(await probeKey({ provider, apiKey, model: probeModel }));
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
      <label class="field">
        <span>Model</span>
        <input
          type="text"
          value={model}
          placeholder={defaultModel(provider)}
          onInput={(e) => setModel(e.currentTarget.value)}
        />
      </label>
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
      <p class="muted small">
        Stays in this browser, sent only to your chosen provider.
        Empty = LLM answering off.
      </p>

      <div class="row">
        <button class="btn primary" onClick={() => void save()}>
          Save settings
        </button>
        <button
          class="btn"
          disabled={apiKey.trim() === "" || testing}
          onClick={() => void test()}
        >
          {testing ? "Testing..." : "Test key"}
        </button>
        {flash !== "" && <span class="flash">{flash}</span>}
      </div>
      {testMsg !== "" && (
        <p class={testMsg === "Key works." ? "small ok-text" : "small warn"}>{testMsg}</p>
      )}
    </div>
  );
}
