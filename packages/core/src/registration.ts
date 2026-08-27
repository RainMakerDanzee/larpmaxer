/**
 * Auth-wall detection and registration/login form discovery.
 *
 * Portals gate applications behind candidate accounts. This module classifies
 * what a page is asking for and locates the fields LarpMaxer needs to fill —
 * pure over the passed document, so it tests against fixtures in Node.
 * The consent/credential flow that USES this lives in the extension
 * (docs/registration.md): consent once per portal, then autonomous.
 */

/** What kind of auth wall (if any) the page presents. */
export type AuthWall = "login" | "registration" | null;

/** Field selectors for filling an auth form. Selectors are id-based when possible. */
export interface AuthForm {
  kind: Exclude<AuthWall, null>;
  emailSelector: string;
  /** One selector per password box (registration often has password + confirm). */
  passwordSelectors: string[];
  firstNameSelector?: string;
  lastNameSelector?: string;
  /** Full-name single field, when the form uses one box. */
  nameSelector?: string;
  submitSelector: string;
}

const REGISTER_TEXT = /(create|register|sign\s*up|new\s+(account|user)|join)/i;
const LOGIN_TEXT = /(log\s*in|sign\s*in)/i;

/** Classify the page: registration wall, login wall, or no auth wall at all. */
export function detectAuthWall(doc: Document): AuthWall {
  const passwords = visiblePasswordInputs(doc);
  if (passwords.length === 0) return null;
  if (passwords.length >= 2) return "registration";
  const auto = passwords[0]!.getAttribute("autocomplete") ?? "";
  if (auto === "new-password") return "registration";
  const formText = (passwords[0]!.closest("form") ?? doc.body).textContent ?? "";
  // Login pages routinely link to "create an account" — weigh the submit
  // control's own text above ambient page text.
  const submit = findSubmit(doc, passwords[0]!);
  const submitText = submit?.textContent ?? (submit as HTMLInputElement | null)?.value ?? "";
  if (REGISTER_TEXT.test(submitText)) return "registration";
  if (LOGIN_TEXT.test(submitText)) return "login";
  return REGISTER_TEXT.test(formText) && !LOGIN_TEXT.test(formText) ? "registration" : "login";
}

/** Locate the auth form's fields; null when the page has no fillable wall. */
export function findAuthForm(doc: Document): AuthForm | null {
  const kind = detectAuthWall(doc);
  if (kind === null) return null;
  const passwords = visiblePasswordInputs(doc);
  const scope = passwords[0]!.closest("form") ?? doc.body;

  const email =
    scope.querySelector<HTMLInputElement>('input[type="email"]') ??
    scope.querySelector<HTMLInputElement>(
      'input[autocomplete="email"], input[autocomplete="username"]',
    ) ??
    Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="text"]')).find((i) =>
      /mail|user/i.test(`${i.name} ${i.id} ${i.placeholder}`),
    );
  if (!email) return null;

  const submit = findSubmit(doc, passwords[0]!);
  if (!submit) return null;

  const byAuto = (token: string): HTMLInputElement | null =>
    scope.querySelector<HTMLInputElement>(`input[autocomplete="${token}"]`);
  const byGuess = (re: RegExp): HTMLInputElement | undefined =>
    Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="text"]')).find((i) =>
      re.test(`${i.name} ${i.id} ${i.placeholder}`),
    );

  const first = byAuto("given-name") ?? byGuess(/first.?name|given/i) ?? null;
  const last = byAuto("family-name") ?? byGuess(/last.?name|surname|family/i) ?? null;
  const full = first === null && last === null ? (byAuto("name") ?? byGuess(/^name$|full.?name/i) ?? null) : null;

  return {
    kind,
    emailSelector: selectorFor(email),
    passwordSelectors: passwords.map(selectorFor),
    ...(first ? { firstNameSelector: selectorFor(first) } : {}),
    ...(last ? { lastNameSelector: selectorFor(last) } : {}),
    ...(full ? { nameSelector: selectorFor(full) } : {}),
    submitSelector: selectorFor(submit),
  };
}

// ---------------------------------------------------------------------------

function visiblePasswordInputs(doc: Document): HTMLInputElement[] {
  return Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(
    (i) => !i.disabled && i.getAttribute("aria-hidden") !== "true",
  );
}

function findSubmit(doc: Document, anchor: HTMLInputElement): HTMLElement | null {
  const scope = anchor.closest("form") ?? doc.body;
  return (
    scope.querySelector<HTMLElement>('button[type="submit"], input[type="submit"]') ??
    Array.from(scope.querySelectorAll<HTMLElement>("button")).find((b) =>
      REGISTER_TEXT.test(b.textContent ?? "") || LOGIN_TEXT.test(b.textContent ?? ""),
    ) ??
    null
  );
}

/** Stable selector: prefer #id, then [name], then a tag+type fallback. */
function selectorFor(el: HTMLElement): string {
  if (el.id !== "") return `#${cssEscape(el.id)}`;
  const name = el.getAttribute("name");
  if (name !== null && name !== "") return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
  const type = el.getAttribute("type");
  return type === null ? el.tagName.toLowerCase() : `${el.tagName.toLowerCase()}[type="${type}"]`;
}

/** Minimal CSS.escape — jsdom and every target browser support the real one. */
function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}
