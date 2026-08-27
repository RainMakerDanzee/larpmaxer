/**
 * Time windows for the queue and the history list.
 *
 * A job search accumulates: links dropped in weeks ago, applications sent
 * months back. Both lists grow until they stop being readable, and a posting
 * that has sat unqueued for a month is usually filled or closed — worth
 * showing, worth marking, not worth showing first.
 *
 * Pure over an explicit `now`, so the behaviour at a boundary can be tested
 * rather than hoped at.
 */

/** How far back a list is showing. */
export type DateWindow = "24h" | "7d" | "30d" | "all";

/** Window lengths in days; `null` means no cutoff. */
export const WINDOW_DAYS: Record<DateWindow, number | null> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  all: null,
};

/** Labels for the filter control. */
export const WINDOW_LABEL: Record<DateWindow, string> = {
  "24h": "24 hours",
  "7d": "Week",
  "30d": "Month",
  all: "All",
};

/** A posting untouched for this long is treated as stale. */
export const STALE_DAYS = 30;

const DAY_MS = 86_400_000;

/** Milliseconds since `iso`, or null when it is missing or unparseable. */
export function ageMs(iso: string | undefined, now: number): number | null {
  if (iso === undefined || iso === "") return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : now - at;
}

/**
 * Is `iso` inside `window`?
 *
 * An absent or unreadable timestamp is kept, never hidden: a filter exists to
 * narrow a list, and silently dropping a record because its date could not be
 * read would misrepresent what the user has actually applied to. A future
 * timestamp (clock skew) counts as recent.
 */
export function isWithin(iso: string | undefined, window: DateWindow, now: number): boolean {
  const days = WINDOW_DAYS[window];
  if (days === null) return true;
  const age = ageMs(iso, now);
  if (age === null) return true;
  return age <= days * DAY_MS;
}

/** True when a posting has sat around long enough to be probably gone. */
export function isStale(iso: string | undefined, now: number, days: number = STALE_DAYS): boolean {
  const age = ageMs(iso, now);
  return age !== null && age > days * DAY_MS;
}

/**
 * A short human age: "just now", "4h ago", "3d ago", "2mo ago".
 *
 * Deliberately terse — it sits beside a job title in a narrow panel, where a
 * full sentence would push the title out of view.
 */
export function relativeAge(iso: string | undefined, now: number): string {
  const age = ageMs(iso, now);
  if (age === null) return "";
  if (age < 0) return "just now";
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Sort so fresh items come first and stale ones sink.
 *
 * Stale entries are moved, not removed — the user dropped them in deliberately,
 * and quietly deleting someone's queue is not this tool's call to make.
 */
export function byFreshness<T>(
  items: readonly T[],
  timestamp: (item: T) => string | undefined,
  now: number,
): T[] {
  return [...items].sort((a, b) => {
    const staleA = isStale(timestamp(a), now);
    const staleB = isStale(timestamp(b), now);
    if (staleA !== staleB) return staleA ? 1 : -1;
    const ageA = ageMs(timestamp(a), now) ?? Number.POSITIVE_INFINITY;
    const ageB = ageMs(timestamp(b), now) ?? Number.POSITIVE_INFINITY;
    return ageA - ageB;
  });
}
