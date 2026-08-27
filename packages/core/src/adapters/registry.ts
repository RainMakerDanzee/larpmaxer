/**
 * Adapter registry: the ordered adapter list and the picker used by detect.
 *
 * Branded adapters come first. `generic` must stay LAST because it matches
 * every URL; its own `detect()` is the gate that only claims pages with a
 * plausible application form (file input, or >= 3 labelled inputs, plus a
 * submit-ish control).
 */
import type { Adapter } from "../types.js";
import { greenhouse } from "./greenhouse.js";
import { lever } from "./lever.js";
import { ashby } from "./ashby.js";
import { generic } from "./generic.js";

/** Every adapter LarpMaxer ships, in registry pick order (generic fallback last). */
export const allAdapters: readonly Adapter[] = [greenhouse, lever, ashby, generic];

/** First adapter whose `matchesUrl` and `detect` both pass, or null when the page has no application form. */
export function pickAdapter(url: string, doc: Document): Adapter | null {
  for (const adapter of allAdapters) {
    if (adapter.matchesUrl(url) && adapter.detect(url, doc)) return adapter;
  }
  return null;
}
