import { describe, expect, it } from "vitest";
import type { LlmMessage, LlmProvider } from "../src/types.js";
import { buildRefineMessages, refineResume } from "../src/resume/refine.js";
import { parseResume } from "../src/resume/extract.js";

/**
 * A resume the heuristics read only partly: the second role's dates sit on the
 * same line as its title, which the date-anchored parser does not split.
 */
const RESUME = `Riley Park
Sydney, NSW · riley.park@example.com · +61 400 000 000
linkedin.com/in/rileypark

PROFESSIONAL SUMMARY
Data analyst who automates the boring parts.

TECHNICAL SKILLS
Python, SQL, Power BI, dbt, Airflow

WORK EXPERIENCE
Senior Data Analyst — Acme Pty Ltd
Mar 2022 - Present
- Rebuilt the weekly reporting pipeline, cutting runtime from 6 hours to 20 minutes.

Data Analyst, Example Co (Jan 2019 – Feb 2022)
- Built the churn model in scikit-learn that became the retention team's triage tool.

EDUCATION
Bachelor of Information Technology — Macquarie University
2018
`;

const heuristic = parseResume(RESUME);

/** A provider that replies with whatever the test dictates, or throws. */
function fake(reply: string | (() => never)): LlmProvider {
  return {
    id: "anthropic",
    complete: async (): Promise<string> => (typeof reply === "string" ? reply : reply()),
  };
}

const json = (v: unknown): string => JSON.stringify(v);

describe("refineResume — what it accepts", () => {
  it("repairs a role the heuristics mangled", async () => {
    // The heuristics fold this role's title, employer and dates into one string
    // and leave the company empty — the case refinement exists for.
    expect(heuristic.experience[1]).toMatchObject({
      title: "Data Analyst, Example Co ( )",
      company: "",
    });

    const out = await refineResume(
      heuristic,
      fake(
        json({
          experience: [
            { title: "Senior Data Analyst", company: "Acme Pty Ltd", start: "2022-03", end: "present" },
            { title: "Data Analyst", company: "Example Co", start: "2019-01", end: "2022-02" },
          ],
        }),
      ),
    );

    expect(out.experience[1]).toMatchObject({ title: "Data Analyst", company: "Example Co" });
  });

  it("keeps both roles with their highlights when the resume supports them", async () => {
    const out = await refineResume(
      heuristic,
      fake(
        json({
          experience: [
            {
              title: "Senior Data Analyst",
              company: "Acme Pty Ltd",
              start: "2022-03",
              end: "present",
              highlights: ["Rebuilt the weekly reporting pipeline, cutting runtime from 6 hours to 20 minutes."],
            },
            {
              title: "Data Analyst",
              company: "Example Co",
              start: "2019-01",
              end: "2022-02",
              highlights: ["Built the churn model in scikit-learn that became the retention team's triage tool."],
            },
          ],
        }),
      ),
    );

    expect(out.experience).toHaveLength(2);
    expect(out.experience[1]).toMatchObject({
      title: "Data Analyst",
      company: "Example Co",
      start: "2019-01",
      end: "2022-02",
    });
    expect(out.experience[1]?.highlights[0]).toContain("churn model");
  });

  it("accepts a phone the model reformatted, since the digits are the same", async () => {
    const out = await refineResume(heuristic, fake(json({ phone: "+61 400 000 000" })));
    expect(out.phone).toBe("+61 400 000 000");
  });

  it("reads JSON out of a markdown fence", async () => {
    const out = await refineResume(
      heuristic,
      fake("Here you go:\n```json\n" + json({ location: "Sydney, NSW" }) + "\n```\n"),
    );
    expect(out.location).toBe("Sydney, NSW");
  });

  it("reads JSON with prose either side of it", async () => {
    const out = await refineResume(
      heuristic,
      fake(`Sure. ${json({ location: "Sydney, NSW" })} Let me know if that helps.`),
    );
    expect(out.location).toBe("Sydney, NSW");
  });

  it("adds a skill named in a role bullet, which the skills section omits", async () => {
    expect(heuristic.skills).not.toContain("scikit-learn");

    const out = await refineResume(heuristic, fake(json({ skills: ["scikit-learn"] })));
    expect(out.skills).toContain("scikit-learn");
    expect(out.skills).toEqual(expect.arrayContaining(heuristic.skills));
  });

  it("keeps education it can find in the text", async () => {
    const out = await refineResume(
      heuristic,
      fake(
        json({
          education: [
            {
              institution: "Macquarie University",
              qualification: "Bachelor of Information Technology",
              year: "2018",
            },
          ],
        }),
      ),
    );
    expect(out.education[0]).toMatchObject({
      institution: "Macquarie University",
      qualification: "Bachelor of Information Technology",
      year: "2018",
    });
  });
});

describe("refineResume — what it refuses", () => {
  it("discards an employer the resume never mentions", async () => {
    const out = await refineResume(
      heuristic,
      fake(
        json({
          experience: [
            { title: "Senior Data Analyst", company: "Acme Pty Ltd", start: "2022-03", end: "present" },
            { title: "Principal Engineer", company: "Google", start: "2015-01", end: "2018-12" },
          ],
        }),
      ),
    );
    expect(out.experience.map((e) => e.company)).toEqual(["Acme Pty Ltd"]);
  });

  it("drops a role whole when only part of it is invented", async () => {
    const out = await refineResume(
      heuristic,
      fake(
        json({
          // Real employer, invented title.
          experience: [{ title: "Head of Data", company: "Acme Pty Ltd", start: "2022-03", end: "present" }],
        }),
      ),
    );
    expect(out.experience).toEqual(heuristic.experience);
  });

  it("discards skills that are not in the resume", async () => {
    const out = await refineResume(
      heuristic,
      fake(json({ skills: ["Python", "SQL", "Kubernetes", "Rust"] })),
    );
    expect(out.skills).not.toContain("Kubernetes");
    expect(out.skills).not.toContain("Rust");
  });

  it("keeps the heuristic skills when every suggestion is invented", async () => {
    const out = await refineResume(heuristic, fake(json({ skills: ["Kubernetes", "Rust"] })));
    expect(out.skills).toEqual(heuristic.skills);
  });

  it("never drops a skill the heuristics already read", async () => {
    // A terse reply must not shrink the list: everything already there stays.
    const out = await refineResume(heuristic, fake(json({ skills: ["Python"] })));
    expect(out.skills).toEqual(expect.arrayContaining(heuristic.skills));
  });

  it("discards a name that is not in the resume", async () => {
    const out = await refineResume(heuristic, fake(json({ name: "Jordan Fletcher" })));
    expect(out.name).toBe("Riley Park");
  });

  it("discards an invented email and phone", async () => {
    const out = await refineResume(
      heuristic,
      fake(json({ email: "riley@bigcorp.com", phone: "+61 411 999 888" })),
    );
    expect(out.email).toBe("riley.park@example.com");
    expect(out.phone).toBe("+61 400 000 000");
  });

  it("drops a role whose dates are not dates", async () => {
    const out = await refineResume(
      heuristic,
      fake(
        json({
          experience: [
            { title: "Senior Data Analyst", company: "Acme Pty Ltd", start: "a while ago", end: "recently" },
          ],
        }),
      ),
    );
    expect(out.experience).toEqual(heuristic.experience);
  });

  it("discards a highlight the resume does not contain, keeping the role", async () => {
    const out = await refineResume(
      heuristic,
      fake(
        json({
          experience: [
            {
              title: "Senior Data Analyst",
              company: "Acme Pty Ltd",
              start: "2022-03",
              end: "present",
              highlights: ["Rebuilt the weekly reporting pipeline, cutting runtime from 6 hours to 20 minutes.", "Managed a team of 12 engineers."],
            },
          ],
        }),
      ),
    );
    expect(out.experience[0]?.highlights).toEqual([
      "Rebuilt the weekly reporting pipeline, cutting runtime from 6 hours to 20 minutes.",
    ]);
  });

  it("discards an education year the resume does not state", async () => {
    const out = await refineResume(
      heuristic,
      fake(
        json({
          education: [
            {
              institution: "Macquarie University",
              qualification: "Bachelor of Information Technology",
              year: "2021",
            },
          ],
        }),
      ),
    );
    expect(out.education[0]?.year).toBeUndefined();
  });
});

describe("refineResume — never worse than the heuristic", () => {
  it("returns the heuristic when the provider throws", async () => {
    const out = await refineResume(
      heuristic,
      fake(() => {
        throw new Error("rate limited");
      }),
    );
    expect(out).toEqual(heuristic);
  });

  it("returns the heuristic when the reply is not JSON", async () => {
    expect(await refineResume(heuristic, fake("I'm afraid I can't help with that."))).toEqual(
      heuristic,
    );
  });

  it("returns the heuristic when the reply is empty", async () => {
    expect(await refineResume(heuristic, fake(""))).toEqual(heuristic);
  });

  it("returns the heuristic when the reply is a JSON array, not an object", async () => {
    expect(await refineResume(heuristic, fake("[1, 2, 3]"))).toEqual(heuristic);
  });

  it("ignores fields of the wrong type", async () => {
    const out = await refineResume(
      heuristic,
      fake(json({ name: 42, skills: "Python, SQL", experience: "lots" })),
    );
    expect(out.name).toBe(heuristic.name);
    expect(out.skills).toEqual(heuristic.skills);
    expect(out.experience).toEqual(heuristic.experience);
  });

  it("keeps the raw text so a later pass can re-read the original", async () => {
    const out = await refineResume(heuristic, fake(json({ name: "Riley Park" })));
    expect(out.raw).toBe(RESUME);
  });
});

describe("buildRefineMessages", () => {
  const messages: LlmMessage[] = buildRefineMessages(heuristic);

  it("puts the resume text and the heuristic parse in front of the model", () => {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("Riley Park");
    expect(user).toContain("Acme Pty Ltd");
    expect(user).toContain('"skills"');
  });

  it("does not send the raw text twice", () => {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    // `raw` is stripped from the JSON block, so the resume body appears once.
    expect(user.split("PROFESSIONAL SUMMARY")).toHaveLength(2);
  });

  it("tells the model the resume is the only source of truth", () => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("only source of truth");
    expect(system).toContain("Never invent");
  });
});
