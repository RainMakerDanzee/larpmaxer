/**
 * @larpmaxer/core — public API surface.
 *
 * Everything the extension (or a Node CLI/test) may use is re-exported here;
 * deep imports into src/ are not part of the contract. Modules follow the
 * ARCHITECTURE.md table. fill/* modules touch the DOM only at call time, so
 * importing this barrel stays safe in Node.
 */

export * from "./types.js";
export * from "./profile.js";
export * from "./answers.js";
export * from "./fill/events.js";
export * from "./fill/files.js";
export * from "./fill/dom.js";
export * from "./adapters/index.js";
export * from "./llm/index.js";
export * from "./messages.js";
export * from "./ledger.js";
export * from "./registration.js";
export * from "./resume/extract.js";
export * from "./resume/text.js";
export * from "./resume/refine.js";
