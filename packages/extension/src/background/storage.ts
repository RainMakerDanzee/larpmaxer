/**
 * Typed persistence over chrome.storage.local.
 *
 * Everything lives locally (rule 4: local-first — no server, no sync, no
 * telemetry). Read-modify-write helpers here are not atomic, so route writes
 * through the background service worker, the single writer.
 */

import type {
  ApplicationRecord,
  AutonomyMode,
  LlmConfig,
  PortalCredential,
  Profile,
} from "@larpmaxer/core";

/**
 * User-tunable extension settings.
 *
 * The LLM `apiKey` inside {@link LlmConfig} is stored here on purpose: it
 * stays in chrome.storage.local like everything else — never synced, never
 * sent anywhere except directly to the user's own chosen LLM provider.
 */
export interface Settings {
  /** "review" (default) gates every submit; "auto" is an explicit opt-in. */
  autonomy: AutonomyMode;
  /**
   * The chosen provider. Unset means the on-device default, not "off" — see
   * {@link getSettings}. A cloud provider is inert without `apiKey`.
   */
  llm?: LlmConfig;
  /**
   * Explicitly answer without any model. Only an unset `llm` plus this flag
   * means off; it exists so "no key" no longer has to double as "no LLM",
   * now that a keyless provider is the default.
   */
  llmOff?: boolean;
  /** Save per-application artifacts + ledger.xlsx to Downloads/LarpMaxer (default on). */
  saveArtifacts?: boolean;
  /** Create portal accounts autonomously after one consent per site (default on). */
  autoRegister?: boolean;
}

/**
 * The keyless default: Chrome's own on-device model.
 *
 * `apiKey` and `model` are inert for this provider — the browser ships the
 * weights and picks the model — but the shape is shared with the cloud
 * providers, so they are present and empty.
 */
const ON_DEVICE: LlmConfig = { provider: "chrome", apiKey: "", model: "" };

const KEY_PROFILE = "profile";
const KEY_SETTINGS = "settings";
const KEY_RECORDS = "records";

/** Resume bytes live under their own keys so profile reads stay small. */
const resumeKey = (id: string): string => `resume:${id}`;

async function read<T>(key: string): Promise<T | undefined> {
  const got = await chrome.storage.local.get(key);
  return got[key] as T | undefined;
}

/** Load the user's profile, or `undefined` before first setup. */
export async function getProfile(): Promise<Profile | undefined> {
  return read<Profile>(KEY_PROFILE);
}

/** Persist the whole profile. Callers pass the complete object — no merging. */
export async function setProfile(profile: Profile): Promise<void> {
  await chrome.storage.local.set({ [KEY_PROFILE]: profile });
}

/**
 * Load settings; defaults to review mode (the approval gate) when unset.
 *
 * A user who never opens Settings still gets a working model: with no stored
 * choice, answering runs on the browser's own on-device model, which needs no
 * key and no account. Only `llmOff` turns that off.
 */
export async function getSettings(): Promise<Settings> {
  const stored = await read<Settings>(KEY_SETTINGS);
  const settings: Settings = {
    autonomy: "review",
    saveArtifacts: true,
    autoRegister: true,
    ...stored,
  };
  if (settings.llm === undefined && settings.llmOff !== true) settings.llm = ON_DEVICE;
  return settings;
}

/** Persist settings, including the local-only LLM API key. */
export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY_SETTINGS]: settings });
}

/** Every stored application record, oldest first. */
export async function getRecords(): Promise<ApplicationRecord[]> {
  return (await read<ApplicationRecord[]>(KEY_RECORDS)) ?? [];
}

/**
 * Upsert one record by id — runs re-save the same record as phases advance,
 * so the list holds one row per application, not per transition.
 */
export async function addRecord(record: ApplicationRecord): Promise<void> {
  const records = await getRecords();
  const at = records.findIndex((r) => r.id === record.id);
  if (at === -1) records.push(record);
  else records[at] = record;
  await chrome.storage.local.set({ [KEY_RECORDS]: records });
}

/** Store a resume's raw bytes (base64 under the hood), keyed by `ResumeRef.id`. */
export async function storeResumeBytes(id: string, bytes: Uint8Array): Promise<void> {
  await chrome.storage.local.set({ [resumeKey(id)]: toBase64(bytes) });
}

/** Load a resume's bytes, or `undefined` if that `ResumeRef.id` was never stored. */
export async function getResumeBytes(id: string): Promise<Uint8Array | undefined> {
  const b64 = await read<string>(resumeKey(id));
  return b64 === undefined ? undefined : fromBase64(b64);
}

/** Load a resume's bytes as stored (base64) — what EXECUTE_PLAN puts on the wire. */
export async function getResumeBase64(id: string): Promise<string | undefined> {
  return read<string>(resumeKey(id));
}

/** Delete a resume's stored bytes; call when its `ResumeRef` is removed. */
export async function deleteResumeBytes(id: string): Promise<void> {
  await chrome.storage.local.remove(resumeKey(id));
}

const KEY_CREDENTIALS = "credentials";

/** All portal credentials LarpMaxer has created (docs/registration.md). */
export async function getCredentials(): Promise<PortalCredential[]> {
  return (await read<PortalCredential[]>(KEY_CREDENTIALS)) ?? [];
}

/** Store/refresh one portal credential, keyed by origin. */
export async function putCredential(cred: PortalCredential): Promise<void> {
  const all = await getCredentials();
  const at = all.findIndex((c) => c.origin === cred.origin);
  if (at === -1) all.push(cred);
  else all[at] = cred;
  await chrome.storage.local.set({ [KEY_CREDENTIALS]: all });
}

/** Credential for an origin, or undefined before first registration there. */
export async function getCredential(origin: string): Promise<PortalCredential | undefined> {
  return (await getCredentials()).find((c) => c.origin === origin);
}

/** Generate a 20-char password satisfying common portal complexity policies. */
export function generatePassword(): string {
  const sets = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnopqrstuvwxyz",
    "23456789",
    "!@#$%^&*",
  ];
  const all = sets.join("");
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b, i) =>
    i < sets.length ? sets[i]![b % sets[i]!.length]! : all[b % all.length]!,
  );
  // Shuffle so the guaranteed-class characters are not positionally predictable.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

// btoa/atob work on binary strings; chunk to stay under call-argument limits.
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
