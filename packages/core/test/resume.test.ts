import { describe, expect, it } from "vitest";
import {
  extractContact,
  extractEducation,
  extractExperience,
  extractName,
  extractSkills,
  mergeIntoProfile,
  parseResume,
  splitSections,
} from "../src/resume/extract.js";
import { emptyProfile } from "../src/profile.js";

/** A realistic single-column resume, of the shape the heuristics target. */
const RESUME = `Riley Park
Sydney, NSW · riley.park@example.com · +61 400 000 000
linkedin.com/in/rileypark · github.com/rileypark

PROFESSIONAL SUMMARY
Data analyst who automates the boring parts. Six years turning messy
operational data into things people actually decide with.

TECHNICAL SKILLS
Python, SQL, Power BI, dbt, Airflow, Snowflake, Git

WORK EXPERIENCE
Senior Data Analyst — Acme Pty Ltd
Mar 2022 - Present
- Rebuilt the weekly reporting pipeline, cutting runtime from 6 hours to 20 minutes.
- Led migration of 40+ legacy reports into a governed semantic layer.

Data Analyst — Example Co
Jan 2019 - Feb 2022
- Built the churn model that became the retention team's default triage tool.

EDUCATION
Bachelor of Information Technology — Macquarie University
2018
`;

describe("extractContact", () => {
  it("reads email, phone and labelled profile links", () => {
    const c = extractContact(RESUME);
    expect(c.email).toBe("riley.park@example.com");
    expect(c.phone).toBe("+61 400 000 000");
    expect(c.links.map((l) => l.label)).toEqual(expect.arrayContaining(["LinkedIn", "GitHub"]));
    expect(c.links.find((l) => l.label === "LinkedIn")?.url).toBe(
      "https://linkedin.com/in/rileypark",
    );
  });

  it("leaves absent details absent rather than guessing", () => {
    const c = extractContact("Just some prose with no contact details at all.");
    expect(c.email).toBeUndefined();
    expect(c.phone).toBeUndefined();
    expect(c.links).toEqual([]);
  });

  it("does not mistake a year or postcode for a phone number", () => {
    expect(extractContact("Graduated 2018, based in 2000 Sydney.").phone).toBeUndefined();
  });
});

describe("extractName", () => {
  it("takes the name from the top of the document", () => {
    expect(extractName(RESUME)).toBe("Riley Park");
  });

  it("skips a 'Curriculum Vitae' style heading", () => {
    expect(extractName("CURRICULUM VITAE\nJordan Diaz\njordan@example.com")).toBe("Jordan Diaz");
  });

  it("returns undefined rather than guessing when the top is a contact row", () => {
    expect(extractName("hello@example.com | +61 400 000 000 | Sydney")).toBeUndefined();
  });
});

describe("splitSections", () => {
  it("finds the canonical sections regardless of heading wording", () => {
    const keys = splitSections(RESUME).map((s) => s.key);
    expect(keys).toEqual(["summary", "skills", "experience", "education"]);
  });

  it("gives each section only its own body", () => {
    const skills = splitSections(RESUME).find((s) => s.key === "skills")!;
    expect(skills.body).toContain("Python");
    expect(skills.body).not.toContain("Senior Data Analyst");
  });
});

describe("extractSkills", () => {
  it("splits a comma-separated skills line", () => {
    expect(extractSkills("Python, SQL, Power BI, dbt")).toEqual([
      "Python",
      "SQL",
      "Power BI",
      "dbt",
    ]);
  });

  it("drops prose sentences that are not skills", () => {
    const skills = extractSkills("Python\nI am passionate about building great products.");
    expect(skills).toContain("Python");
    expect(skills).not.toContain("I am passionate about building great products.");
  });
});

describe("extractExperience", () => {
  const roles = extractExperience(
    splitSections(RESUME).find((s) => s.key === "experience")!.body,
  );

  it("finds every dated role", () => {
    expect(roles).toHaveLength(2);
  });

  it("splits title from employer", () => {
    expect(roles[0]!.title).toBe("Senior Data Analyst");
    expect(roles[0]!.company).toBe("Acme Pty Ltd");
  });

  it("normalises dates, including an open-ended current role", () => {
    expect(roles[0]!.start).toBe("2022-03");
    expect(roles[0]!.end).toBe("present");
    expect(roles[1]!.start).toBe("2019-01");
    expect(roles[1]!.end).toBe("2022-02");
  });

  it("attaches the bullets under each role and stops at the next one", () => {
    expect(roles[0]!.highlights).toHaveLength(2);
    expect(roles[0]!.highlights[0]).toContain("6 hours to 20 minutes");
    expect(roles[1]!.highlights).toHaveLength(1);
    expect(roles[1]!.highlights[0]).toContain("churn model");
  });
});

describe("extractEducation", () => {
  it("reads the qualification, institution and year", () => {
    const edu = extractEducation(
      splitSections(RESUME).find((s) => s.key === "education")!.body,
    );
    expect(edu).toHaveLength(1);
    expect(edu[0]!.qualification).toBe("Bachelor of Information Technology");
    expect(edu[0]!.institution).toBe("Macquarie University");
    expect(edu[0]!.year).toBe("2018");
  });
});

describe("parseResume", () => {
  const parsed = parseResume(RESUME);

  it("produces a complete profile draft from one document", () => {
    expect(parsed.name).toBe("Riley Park");
    expect(parsed.email).toBe("riley.park@example.com");
    expect(parsed.skills.length).toBeGreaterThan(4);
    expect(parsed.experience).toHaveLength(2);
    expect(parsed.education).toHaveLength(1);
    expect(parsed.summary).toContain("automates the boring parts");
  });

  it("keeps the raw text so a later LLM pass can re-read the original", () => {
    expect(parsed.raw).toBe(RESUME);
  });

  it("degrades to empty structures on an unparseable document, without throwing", () => {
    const junk = parseResume("%PDF-1.7 garbled binary-ish text with no structure");
    expect(junk.experience).toEqual([]);
    expect(junk.skills).toEqual([]);
    expect(junk.sections).toEqual([]);
  });
});

describe("mergeIntoProfile", () => {
  it("fills an empty profile from the parse", () => {
    const merged = mergeIntoProfile(parseResume(RESUME));
    expect(merged.name).toBe("Riley Park");
    expect(merged.experience).toHaveLength(2);
  });

  it("never overwrites what the user already entered", () => {
    const existing = { ...emptyProfile(), name: "R. Park", email: "me@work.example" };
    const merged = mergeIntoProfile(parseResume(RESUME), existing);
    expect(merged.name).toBe("R. Park");
    expect(merged.email).toBe("me@work.example");
    // …but still fills what was blank.
    expect(merged.phone).toBe("+61 400 000 000");
    expect(merged.skills.length).toBeGreaterThan(0);
  });
});
