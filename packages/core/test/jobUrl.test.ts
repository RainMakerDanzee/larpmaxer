import { describe, expect, it } from "vitest";
import { canonicalizeJobUrl } from "../src/jobUrl.js";

describe("canonicalizeJobUrl", () => {
  it("turns a LinkedIn search page with currentJobId into the posting URL (live case 2026-08-28)", () => {
    const pasted =
      "https://www.linkedin.com/jobs/search-results/?currentJobId=4448943487&eBP=NON_CHARGEABLE_CHANNEL&refId=SQYFpAkHJ%2BEp6skZuSqqkg%3D%3D&trackingId=vczRhN5Z5FiQr1N9Fcd2Aw%3D%3D";
    expect(canonicalizeJobUrl(pasted)).toBe("https://www.linkedin.com/jobs/view/4448943487/");
  });

  it("handles the classic /jobs/search/ variant too", () => {
    expect(
      canonicalizeJobUrl("https://www.linkedin.com/jobs/search/?currentJobId=123456&keywords=analyst"),
    ).toBe("https://www.linkedin.com/jobs/view/123456/");
  });

  it("leaves a LinkedIn URL without a job id alone", () => {
    const url = "https://www.linkedin.com/jobs/collections/recommended/";
    expect(canonicalizeJobUrl(url)).toBe(url);
  });

  it("rejects a non-numeric currentJobId rather than building a bogus path", () => {
    const url = "https://www.linkedin.com/jobs/search/?currentJobId=<script>";
    expect(canonicalizeJobUrl(url)).toBe(url);
  });

  it("strips SEEK tracking params down to the job id", () => {
    expect(
      canonicalizeJobUrl("https://au.seek.com/job/94217400?type=standard&ref=search-standalone#sol=abc"),
    ).toBe("https://au.seek.com/job/94217400");
  });

  it("passes every other URL through untouched", () => {
    for (const url of [
      "https://boards.greenhouse.io/acme/jobs/123",
      "https://jobs.lever.co/example/456",
      "https://careers.example.com/apply?id=9",
      "not a url at all",
    ]) {
      expect(canonicalizeJobUrl(url)).toBe(url);
    }
  });
});
