import { describe, expect, it } from "vitest";
import {
  ageMs,
  byFreshness,
  isStale,
  isWithin,
  relativeAge,
  STALE_DAYS,
} from "../src/dates.js";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("isWithin", () => {
  it("keeps something from an hour ago in the 24h window", () => {
    expect(isWithin(ago(HOUR), "24h", NOW)).toBe(true);
  });

  it("drops something from three days ago out of the 24h window", () => {
    expect(isWithin(ago(3 * DAY), "24h", NOW)).toBe(false);
  });

  it("keeps it in the week window", () => {
    expect(isWithin(ago(3 * DAY), "7d", NOW)).toBe(true);
  });

  it("is inclusive exactly on the boundary", () => {
    expect(isWithin(ago(DAY), "24h", NOW)).toBe(true);
    expect(isWithin(ago(DAY + 1), "24h", NOW)).toBe(false);
  });

  it("keeps everything under all", () => {
    expect(isWithin(ago(900 * DAY), "all", NOW)).toBe(true);
  });

  // A filter narrows a list; it must never quietly hide an application the
  // user actually sent because its timestamp could not be read.
  it("keeps a record with no timestamp rather than hiding it", () => {
    expect(isWithin(undefined, "24h", NOW)).toBe(true);
    expect(isWithin("", "24h", NOW)).toBe(true);
  });

  it("keeps a record with an unparseable timestamp", () => {
    expect(isWithin("not a date", "24h", NOW)).toBe(true);
  });

  it("treats a future timestamp as recent, since clocks skew", () => {
    expect(isWithin(new Date(NOW + HOUR).toISOString(), "24h", NOW)).toBe(true);
  });
});

describe("isStale", () => {
  it("is false for something from last week", () => {
    expect(isStale(ago(7 * DAY), NOW)).toBe(false);
  });

  it("is true past the stale threshold", () => {
    expect(isStale(ago((STALE_DAYS + 1) * DAY), NOW)).toBe(true);
  });

  it("is false exactly on the threshold", () => {
    expect(isStale(ago(STALE_DAYS * DAY), NOW)).toBe(false);
  });

  it("never calls a missing timestamp stale", () => {
    expect(isStale(undefined, NOW)).toBe(false);
  });
});

describe("relativeAge", () => {
  it("reads naturally across the scales", () => {
    expect(relativeAge(ago(30_000), NOW)).toBe("just now");
    expect(relativeAge(ago(5 * 60_000), NOW)).toBe("5m ago");
    expect(relativeAge(ago(4 * HOUR), NOW)).toBe("4h ago");
    expect(relativeAge(ago(3 * DAY), NOW)).toBe("3d ago");
    expect(relativeAge(ago(60 * DAY), NOW)).toBe("2mo ago");
    expect(relativeAge(ago(400 * DAY), NOW)).toBe("1y ago");
  });

  it("says nothing when there is no timestamp", () => {
    expect(relativeAge(undefined, NOW)).toBe("");
  });

  it("does not report a negative age from a skewed clock", () => {
    expect(relativeAge(new Date(NOW + HOUR).toISOString(), NOW)).toBe("just now");
  });
});

describe("byFreshness", () => {
  const at = (iso: string | undefined, id: string) => ({ iso, id });
  const stamp = (x: { iso?: string }) => x.iso;

  it("puts the newest first", () => {
    const out = byFreshness(
      [at(ago(5 * DAY), "old"), at(ago(HOUR), "new"), at(ago(DAY), "mid")],
      stamp,
      NOW,
    );
    expect(out.map((x) => x.id)).toEqual(["new", "mid", "old"]);
  });

  it("sinks stale entries below everything fresh, without dropping them", () => {
    const out = byFreshness(
      [at(ago(90 * DAY), "stale"), at(ago(2 * DAY), "fresh")],
      stamp,
      NOW,
    );
    expect(out.map((x) => x.id)).toEqual(["fresh", "stale"]);
    expect(out).toHaveLength(2);
  });

  it("keeps stale entries in age order among themselves", () => {
    const out = byFreshness(
      [at(ago(200 * DAY), "older"), at(ago(40 * DAY), "newer")],
      stamp,
      NOW,
    );
    expect(out.map((x) => x.id)).toEqual(["newer", "older"]);
  });

  it("sorts undateable entries last without treating them as stale", () => {
    const out = byFreshness([at(undefined, "unknown"), at(ago(DAY), "dated")], stamp, NOW);
    expect(out.map((x) => x.id)).toEqual(["dated", "unknown"]);
  });

  it("does not mutate the input", () => {
    const input = [at(ago(5 * DAY), "a"), at(ago(HOUR), "b")];
    byFreshness(input, stamp, NOW);
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("ageMs", () => {
  it("measures from now", () => {
    expect(ageMs(ago(2 * HOUR), NOW)).toBe(2 * HOUR);
  });

  it("returns null for anything it cannot read", () => {
    expect(ageMs(undefined, NOW)).toBeNull();
    expect(ageMs("tuesday", NOW)).toBeNull();
  });
});
