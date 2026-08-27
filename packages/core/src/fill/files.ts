/**
 * Resume attachment without an OS file dialog: bytes → File → DataTransfer →
 * `input.files` → input+change. Pure web APIs — no Node Buffer — so it runs
 * in the content script and, with a minimal DataTransfer polyfill, in jsdom.
 */

import { dispatchInputAndChange, windowOf } from "./events.js";

/** Attach `bytes` to a file input as `filename`, then fire input+change so the page registers the upload. */
export function attachFile(
  input: HTMLInputElement,
  bytes: Uint8Array,
  filename: string,
  mime: string,
): void {
  if (input.type !== "file") {
    throw new Error(
      `larpmaxer: attachFile needs <input type="file">, got type="${input.type}"`,
    );
  }
  const win = windowOf(input);
  if (typeof win.DataTransfer !== "function") {
    throw new Error(
      "larpmaxer: DataTransfer is unavailable — in jsdom, install a minimal polyfill first (see test/fill.test.ts)",
    );
  }
  // Copy the bytes so later mutation of the caller's buffer cannot change the upload.
  const file = new win.File([new Uint8Array(bytes)], filename, { type: mime });
  const dt = new win.DataTransfer();
  dt.items.add(file);
  try {
    // The real setter is the only path the browser's own upload machinery
    // honours — defineProperty alone would fake the read while uploading nothing.
    input.files = dt.files;
  } catch {
    // jsdom's FileList brand check rejects polyfilled lists; shadowing the
    // property keeps page-level reads (input.files[0].name) working in tests.
    Object.defineProperty(input, "files", { value: dt.files, configurable: true });
  }
  dispatchInputAndChange(input);
}
