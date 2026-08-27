import { describe, expect, it } from "vitest";
import {
  emptyProfile,
  mergeQaEntry,
  normalizeQuestion,
  ProfileValidationError,
  validateProfile,
} from "../src/profile.js";
import type { Profile, QAEntry } from "../src/types.js";

function sampleProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    ...emptyProfile(),
    name: "Alex Chen",
    email: "alex@example.com",
    phone: "+61 400 111 222",
    location: "Sydney, NSW, Australia",
    links: [{ label: "LinkedIn", url: "https://www.linkedin.com/in/alexchen" }],
    workRights: "Australian permanent resident",
    needsSponsorship: false,
    noticePeriod: "4 weeks",
    salary: "A$120,000",
    summary: "Data engineer.",
    skills: ["SQL", "Python"],
    experience: [
      {
        title: "Data Engineer",
        company: "Acme",
        start: "2021-03",
        end: "present",
        highlights: ["Built pipelines"],
      },
    ],
    education: [{ institution: "UNSW", qualification: "BSc Computer Science" }],
    qaBank: [],
    resumes: [{ id: "r1", filename: "alex.pdf", mime: "application/pdf" }],
    ...overrides,
  };
}

/** Run validateProfile expecting failure; returns the collected error list. */
function errorsFor(value: unknown): string[] {
  try {
    validateProfile(value);
  } catch (err) {
    if (err instanceof ProfileValidationError) return err.errors;
    throw err;
  }
  throw new Error("expected validateProfile to throw");
}

function hasError(errors: string[], fragment: string): boolean {
  return errors.some((e) => e.includes(fragment));
}

describe("validateProfile", () => {
  it("accepts a fully populated profile and returns the same object", () => {
    const p = sampleProfile();
    expect(validateProfile(p)).toBe(p);
  });

  it("accepts emptyProfile()", () => {
    const p = emptyProfile();
    expect(validateProfile(p)).toBe(p);
  });

  it("ignores unknown extra keys for forward compatibility", () => {
    const p = { ...sampleProfile(), futureField: 123 } as unknown;
    expect(() => validateProfile(p)).not.toThrow();
  });

  it("rejects non-object inputs with a single helpful error", () => {
    for (const bad of [null, undefined, 42, "profile", []]) {
      const errors = errorsFor(bad);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("expected an object");
    }
  });

  it("collects every problem instead of stopping at the first", () => {
    const errors = errorsFor({
      ...sampleProfile(),
      name: 42,
      needsSponsorship: "no",
      summary: null,
      skills: "SQL",
    } as unknown);
    expect(hasError(errors, "name: expected a string, got number")).toBe(true);
    expect(hasError(errors, "needsSponsorship: expected a boolean")).toBe(true);
    expect(hasError(errors, "summary: expected a string, got null")).toBe(true);
    expect(hasError(errors, "skills: expected an array, got string")).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it("mentions the count of problems in the thrown message", () => {
    try {
      validateProfile({ ...sampleProfile(), name: 1, phone: 2 } as unknown);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileValidationError);
      expect((err as ProfileValidationError).message).toContain("Invalid profile (2 problems)");
    }
  });

  it("rejects an email that does not look like an address, but allows empty", () => {
    expect(hasError(errorsFor({ ...sampleProfile(), email: "not-an-email" }), "email")).toBe(true);
    expect(() => validateProfile(sampleProfile({ email: "" }))).not.toThrow();
  });

  it("treats salary as optional but type-checks it when present", () => {
    const { salary: _unused, ...noSalary } = sampleProfile();
    expect(() => validateProfile(noSalary)).not.toThrow();
    expect(hasError(errorsFor({ ...sampleProfile(), salary: null } as unknown), "salary")).toBe(true);
    expect(hasError(errorsFor({ ...sampleProfile(), salary: 95000 } as unknown), "salary")).toBe(true);
  });

  it("validates link entries with indexed paths", () => {
    const errors = errorsFor({
      ...sampleProfile(),
      links: ["nope", { label: "GitHub", url: 7 }],
    } as unknown);
    expect(hasError(errors, "links[0]: expected an object")).toBe(true);
    expect(hasError(errors, "links[1].url: expected a string")).toBe(true);
  });

  it("validates skills elements", () => {
    const errors = errorsFor({ ...sampleProfile(), skills: ["SQL", 3] } as unknown);
    expect(hasError(errors, "skills[1]: expected a string")).toBe(true);
  });

  it("enforces YYYY-MM experience dates and 'present'", () => {
    const base = sampleProfile();
    const exp = base.experience[0]!;
    const errors = errorsFor({
      ...base,
      experience: [{ ...exp, start: "March 2021", end: "ongoing" }],
    } as unknown);
    expect(hasError(errors, 'experience[0].start: expected YYYY-MM, got "March 2021"')).toBe(true);
    expect(hasError(errors, 'experience[0].end: expected YYYY-MM or "present"')).toBe(true);

    const badMonth = errorsFor({ ...base, experience: [{ ...exp, start: "2021-13" }] } as unknown);
    expect(hasError(badMonth, "experience[0].start")).toBe(true);

    expect(() =>
      validateProfile({ ...base, experience: [{ ...exp, start: "2021-03", end: "Present" }] }),
    ).not.toThrow();
    expect(() =>
      validateProfile({ ...base, experience: [{ ...exp, end: "2024-12" }] }),
    ).not.toThrow();
  });

  it("checks highlights is a string array", () => {
    const exp = sampleProfile().experience[0]!;
    const errors = errorsFor({
      ...sampleProfile(),
      experience: [{ ...exp, highlights: "Built pipelines" }],
    } as unknown);
    expect(hasError(errors, "experience[0].highlights: expected an array")).toBe(true);
  });

  it("allows optional education fields to be absent but type-checks them when present", () => {
    expect(() => validateProfile(sampleProfile())).not.toThrow();
    const errors = errorsFor({
      ...sampleProfile(),
      education: [{ institution: "UNSW", qualification: "BSc", year: 2019 }],
    } as unknown);
    expect(hasError(errors, "education[0].year")).toBe(true);
  });

  it("validates qaBank entries: approved boolean, uses non-negative integer", () => {
    const entry = { question: "Q", answer: "A", approved: true, uses: 0 };
    const errors = errorsFor({
      ...sampleProfile(),
      qaBank: [
        { ...entry, approved: "yes" },
        { ...entry, uses: -1 },
        { ...entry, uses: 1.5 },
      ],
    } as unknown);
    expect(hasError(errors, "qaBank[0].approved: expected a boolean")).toBe(true);
    expect(hasError(errors, "qaBank[1].uses: expected a non-negative integer")).toBe(true);
    expect(hasError(errors, "qaBank[2].uses: expected a non-negative integer")).toBe(true);
  });

  it("validates resume refs and allows the optional tag", () => {
    const errors = errorsFor({
      ...sampleProfile(),
      resumes: [{ id: "r1", mime: "application/pdf" }],
    } as unknown);
    expect(hasError(errors, "resumes[0].filename: expected a string")).toBe(true);
    expect(() =>
      validateProfile(
        sampleProfile({
          resumes: [{ id: "r1", filename: "a.pdf", mime: "application/pdf", tag: "data" }],
        }),
      ),
    ).not.toThrow();
  });
});

describe("emptyProfile", () => {
  it("returns a fresh object on every call", () => {
    const a = emptyProfile();
    const b = emptyProfile();
    expect(a).not.toBe(b);
    a.skills.push("SQL");
    expect(b.skills).toEqual([]);
  });
});

describe("normalizeQuestion", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeQuestion("Do you REQUIRE Visa Sponsorship???")).toBe("require visa sponsorship");
  });

  it("strips filler words", () => {
    expect(normalizeQuestion("Are you legally entitled to work in Australia?")).toBe(
      "legally entitled work australia",
    );
  });

  it("keeps interrogative words that carry intent", () => {
    expect(normalizeQuestion("Why did you apply?")).toBe("why apply");
  });

  it("removes apostrophes without splitting words", () => {
    expect(normalizeQuestion("What's your notice period?")).toBe("whats notice period");
  });

  it("treats hyphens as separators", () => {
    expect(normalizeQuestion("Right-to-work status:")).toBe("right work status");
  });

  it("collapses whitespace", () => {
    expect(normalizeQuestion("  hello    world  ")).toBe("hello world");
  });

  it("returns an empty string when only filler remains", () => {
    expect(normalizeQuestion("Do you have any?")).toBe("");
  });
});

describe("mergeQaEntry", () => {
  const entry = (question: string, answer: string, extras: Partial<QAEntry> = {}): QAEntry => ({
    question,
    answer,
    approved: true,
    uses: 0,
    ...extras,
  });

  it("appends a new question", () => {
    const profile = sampleProfile();
    const merged = mergeQaEntry(profile, entry("Why us?", "Because."));
    expect(merged.qaBank).toHaveLength(1);
    expect(merged.qaBank[0]?.question).toBe("Why us?");
  });

  it("does not mutate the input profile or its qaBank", () => {
    const profile = sampleProfile({ qaBank: [entry("Why us?", "Old answer.")] });
    const snapshot = JSON.parse(JSON.stringify(profile)) as unknown;
    const merged = mergeQaEntry(profile, entry("Something new?", "New."));
    expect(profile).toEqual(snapshot);
    expect(merged).not.toBe(profile);
    expect(merged.qaBank).not.toBe(profile.qaBank);
  });

  it("dedupes by normalized question, letting the new entry win but keeping max uses", () => {
    const profile = sampleProfile({
      qaBank: [
        entry("Do you require sponsorship?", "No.", { uses: 3 }),
        entry("Why us?", "Because."),
      ],
    });
    const merged = mergeQaEntry(
      profile,
      entry("do you require SPONSORSHIP", "No, I hold PR.", { uses: 0, approved: true }),
    );
    expect(merged.qaBank).toHaveLength(2);
    const replaced = merged.qaBank[0]!;
    expect(replaced.question).toBe("do you require SPONSORSHIP");
    expect(replaced.answer).toBe("No, I hold PR.");
    expect(replaced.uses).toBe(3); // history preserved
  });

  it("keeps the replaced entry's position in the bank", () => {
    const profile = sampleProfile({
      qaBank: [entry("First question?", "1"), entry("Second question?", "2")],
    });
    const merged = mergeQaEntry(profile, entry("first question", "1-updated"));
    expect(merged.qaBank[0]?.answer).toBe("1-updated");
    expect(merged.qaBank[1]?.answer).toBe("2");
  });

  it("falls back to raw text for questions that normalize to nothing", () => {
    let profile = mergeQaEntry(sampleProfile(), entry("???", "mystery"));
    profile = mergeQaEntry(profile, entry("!!!", "loud"));
    expect(profile.qaBank).toHaveLength(2); // different raw keys do not collide
    const again = mergeQaEntry(profile, entry("???", "mystery v2"));
    expect(again.qaBank).toHaveLength(2);
    expect(again.qaBank[0]?.answer).toBe("mystery v2");
  });
});
