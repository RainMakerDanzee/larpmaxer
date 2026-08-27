import { describe, expect, it } from "vitest";
import { resolveAnswers } from "../src/answers.js";
import type { AnswerDelegate, ResolutionResult } from "../src/answers.js";
import { emptyProfile } from "../src/profile.js";
import type { FormField, OpenQuestion, Profile, ResolvedAnswer } from "../src/types.js";

function sampleProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    ...emptyProfile(),
    name: "Alex Chen",
    email: "alex@example.com",
    phone: "+61 400 111 222",
    location: "Sydney, NSW, Australia",
    links: [
      { label: "LinkedIn", url: "https://www.linkedin.com/in/alexchen" },
      { label: "Portfolio", url: "https://alexchen.dev" },
    ],
    workRights: "Australian permanent resident",
    needsSponsorship: false,
    noticePeriod: "4 weeks",
    salary: "A$120,000",
    summary: "Data engineer.",
    skills: ["SQL", "Python"],
    resumes: [
      { id: "r1", filename: "alex-data.pdf", mime: "application/pdf", tag: "data" },
      { id: "r2", filename: "alex-governance.pdf", mime: "application/pdf", tag: "governance" },
    ],
    ...overrides,
  };
}

function field(def: Partial<FormField> & Pick<FormField, "id" | "label" | "kind">): FormField {
  return { selector: `#${def.id}`, required: true, ...def };
}

function answerFor(result: ResolutionResult, fieldId: string): ResolvedAnswer {
  const found = result.answers.find((a) => a.fieldId === fieldId);
  if (found === undefined) {
    throw new Error(`no answer for ${fieldId}; needsUser=${JSON.stringify(result.needsUser)}`);
  }
  return found;
}

function openFor(result: ResolutionResult, fieldId: string): OpenQuestion {
  const found = result.needsUser.find((q) => q.fieldId === fieldId);
  if (found === undefined) {
    throw new Error(`no open question for ${fieldId}; answers=${JSON.stringify(result.answers)}`);
  }
  return found;
}

describe("resolveAnswers: direct profile mapping", () => {
  it("maps identity fields from the profile", async () => {
    const result = await resolveAnswers(
      [
        field({ id: "full", label: "Full name", kind: "text" }),
        field({ id: "first", label: "First name *", kind: "text" }),
        field({ id: "last", label: "Last name", kind: "text" }),
        field({ id: "email", label: "Email", kind: "email" }),
        field({ id: "phone", label: "Phone", kind: "tel" }),
        field({ id: "loc", label: "Location (City)", kind: "text" }),
        field({ id: "loc2", label: "Current location", kind: "combobox" }),
      ],
      sampleProfile(),
    );
    expect(result.needsUser).toEqual([]);
    expect(answerFor(result, "full").value).toBe("Alex Chen");
    expect(answerFor(result, "first").value).toBe("Alex");
    expect(answerFor(result, "last").value).toBe("Chen");
    expect(answerFor(result, "email").value).toBe("alex@example.com");
    expect(answerFor(result, "phone").value).toBe("+61 400 111 222");
    expect(answerFor(result, "loc").value).toBe("Sydney, NSW, Australia");
    expect(answerFor(result, "loc2").value).toBe("Sydney, NSW, Australia");
    for (const a of result.answers) expect(a.source).toBe("profile");
  });

  it("splits multi-part surnames after the first given name", async () => {
    const result = await resolveAnswers(
      [
        field({ id: "first", label: "Given name", kind: "text" }),
        field({ id: "last", label: "Surname", kind: "text" }),
      ],
      sampleProfile({ name: "Ana de la Cruz" }),
    );
    expect(answerFor(result, "first").value).toBe("Ana");
    expect(answerFor(result, "last").value).toBe("de la Cruz");
  });

  it("maps link fields to matching profile links and queues unmatched ones", async () => {
    const result = await resolveAnswers(
      [
        field({ id: "li", label: "LinkedIn Profile", kind: "text" }),
        field({ id: "web", label: "Personal website", kind: "text" }),
        field({ id: "gh", label: "GitHub profile", kind: "text", required: false }),
      ],
      sampleProfile(),
    );
    expect(answerFor(result, "li").value).toBe("https://www.linkedin.com/in/alexchen");
    expect(answerFor(result, "web").value).toBe("https://alexchen.dev");
    expect(openFor(result, "gh").reason).toContain("No profile field");
  });

  it("picks options from a location select", async () => {
    const result = await resolveAnswers(
      [
        field({
          id: "office",
          label: "Office location",
          kind: "select",
          options: ["Sydney", "Melbourne", "Brisbane"],
        }),
      ],
      sampleProfile(),
    );
    expect(answerFor(result, "office").value).toBe("Sydney");
  });

  it("maps notice period and start-availability questions", async () => {
    const result = await resolveAnswers(
      [
        field({ id: "notice", label: "Notice period", kind: "text" }),
        field({ id: "start", label: "When can you start?", kind: "text" }),
      ],
      sampleProfile(),
    );
    expect(answerFor(result, "notice").value).toBe("4 weeks");
    expect(answerFor(result, "start").value).toBe("4 weeks");
  });

  it("maps salary when present and queues it when the profile has none", async () => {
    const salaryField = field({ id: "sal", label: "Salary expectations (AUD)", kind: "text" });
    const withSalary = await resolveAnswers([salaryField], sampleProfile());
    expect(answerFor(withSalary, "sal").value).toBe("A$120,000");

    const { salary: _unused, ...noSalary } = sampleProfile();
    const without = await resolveAnswers([salaryField], noSalary);
    expect(without.answers).toEqual([]);
    expect(openFor(without, "sal").reason).toContain("No profile field");
  });

  it("never answers from empty profile values", async () => {
    const result = await resolveAnswers(
      [
        field({ id: "full", label: "Full name", kind: "text" }),
        field({ id: "email", label: "Email", kind: "email" }),
      ],
      emptyProfile(),
    );
    expect(result.answers).toEqual([]);
    expect(result.needsUser).toHaveLength(2);
  });

  it("prefers direct mapping over a qa-bank entry for the same topic", async () => {
    const result = await resolveAnswers(
      [field({ id: "email2", label: "Email address", kind: "text" })],
      sampleProfile({
        qaBank: [
          { question: "What is your email address?", answer: "old@wrong.com", approved: true, uses: 9 },
        ],
      }),
    );
    const answer = answerFor(result, "email2");
    expect(answer.value).toBe("alex@example.com");
    expect(answer.source).toBe("profile");
  });
});

describe("resolveAnswers: sponsorship and work rights", () => {
  it('answers "No" to a sponsorship yes/no when needsSponsorship is false', async () => {
    const result = await resolveAnswers(
      [
        field({
          id: "sponsor",
          label: "Do you require visa sponsorship to work in Australia?",
          kind: "yesno",
        }),
      ],
      sampleProfile({ needsSponsorship: false }),
    );
    const answer = answerFor(result, "sponsor");
    expect(answer.value).toBe("No");
    expect(typeof answer.value).toBe("string");
    expect(answer.source).toBe("profile");
  });

  it('answers "Yes" to a sponsorship yes/no when needsSponsorship is true', async () => {
    const result = await resolveAnswers(
      [field({ id: "sponsor", label: "Do you require sponsorship?", kind: "yesno" })],
      sampleProfile({ needsSponsorship: true }),
    );
    expect(answerFor(result, "sponsor").value).toBe("Yes");
  });

  it("uses the form's own option wording for sponsorship selects", async () => {
    const result = await resolveAnswers(
      [
        field({
          id: "sponsor",
          label: "Will you require visa sponsorship?",
          kind: "select",
          options: ["Yes, I will require sponsorship", "No, I will not require sponsorship"],
        }),
      ],
      sampleProfile({ needsSponsorship: false }),
    );
    expect(answerFor(result, "sponsor").value).toBe("No, I will not require sponsorship");
  });

  it('inverts the answer for "without sponsorship" phrasings', async () => {
    const result = await resolveAnswers(
      [
        field({
          id: "rights",
          label: "Do you have the right to work in Australia without sponsorship?",
          kind: "yesno",
        }),
      ],
      sampleProfile({ needsSponsorship: false }),
    );
    expect(answerFor(result, "rights").value).toBe("Yes");
  });

  it("answers work-authorization yes/no only for sponsorship-free profiles", async () => {
    const authField = field({
      id: "auth",
      label: "Are you legally authorized to work in Australia?",
      kind: "yesno",
    });
    const free = await resolveAnswers([authField], sampleProfile({ needsSponsorship: false }));
    expect(answerFor(free, "auth").value).toBe("Yes");

    const needs = await resolveAnswers([authField], sampleProfile({ needsSponsorship: true }));
    expect(needs.answers).toEqual([]);
    expect(openFor(needs, "auth").fieldId).toBe("auth");
  });

  it("ticks a right-to-work checkbox only when no sponsorship is needed", async () => {
    const box = field({
      id: "confirm",
      label: "I confirm I have the right to work in Australia",
      kind: "checkbox",
    });
    const free = await resolveAnswers([box], sampleProfile({ needsSponsorship: false }));
    expect(answerFor(free, "confirm").value).toBe(true);

    const needs = await resolveAnswers([box], sampleProfile({ needsSponsorship: true }));
    expect(needs.answers).toEqual([]);
  });

  it("matches the work-rights status against select options", async () => {
    const result = await resolveAnswers(
      [
        field({
          id: "status",
          label: "What is your work rights status?",
          kind: "select",
          options: ["Australian citizen", "Permanent resident", "Temporary visa holder"],
        }),
      ],
      sampleProfile(),
    );
    expect(answerFor(result, "status").value).toBe("Permanent resident");
  });

  it("fills free-text work-authorisation fields with the workRights statement", async () => {
    const result = await resolveAnswers(
      [field({ id: "auth", label: "Work authorisation status", kind: "text" })],
      sampleProfile(),
    );
    expect(answerFor(result, "auth").value).toBe("Australian permanent resident");
  });
});

describe("resolveAnswers: file fields", () => {
  it("attaches the first resume when no tag matches", async () => {
    const result = await resolveAnswers(
      [field({ id: "cv", label: "Resume/CV", kind: "file" })],
      sampleProfile(),
    );
    const answer = answerFor(result, "cv");
    expect(answer.resume?.id).toBe("r1");
    expect(answer.value).toBe("alex-data.pdf");
    expect(answer.source).toBe("profile");
  });

  it("prefers a resume whose tag appears in the field label", async () => {
    const result = await resolveAnswers(
      [field({ id: "cv", label: "Governance resume", kind: "file" })],
      sampleProfile(),
    );
    expect(answerFor(result, "cv").resume?.id).toBe("r2");
  });

  it("also matches tags against the field hint", async () => {
    const result = await resolveAnswers(
      [field({ id: "cv", label: "Resume", kind: "file", hint: "Attach your governance CV" })],
      sampleProfile(),
    );
    expect(answerFor(result, "cv").resume?.id).toBe("r2");
  });

  it("queues file fields when the profile has no resumes", async () => {
    const result = await resolveAnswers(
      [field({ id: "cv", label: "Resume/CV", kind: "file" })],
      sampleProfile({ resumes: [] }),
    );
    expect(result.answers).toEqual([]);
    expect(openFor(result, "cv").reason).toMatch(/resume/i);
  });
});

describe("resolveAnswers: qa bank fuzzy matching", () => {
  const whyEntry = {
    question: "Why do you want to work here?",
    answer: "Because I love building data platforms.",
    approved: true,
    uses: 2,
  };

  it("matches a reworded question above the 0.6 overlap threshold", async () => {
    const result = await resolveAnswers(
      [field({ id: "why", label: "Why do you want to work at Acme?", kind: "textarea" })],
      sampleProfile({ qaBank: [whyEntry] }),
    );
    const answer = answerFor(result, "why");
    expect(answer.value).toBe("Because I love building data platforms.");
    expect(answer.source).toBe("qa_bank");
  });

  it("prefers the entry with the higher overlap score", async () => {
    const result = await resolveAnswers(
      [field({ id: "why", label: "Why do you want to work at Acme?", kind: "textarea" })],
      sampleProfile({
        qaBank: [
          whyEntry,
          {
            question: "Why do you want to work at Acme specifically?",
            answer: "Acme-specific answer.",
            approved: true,
            uses: 0,
          },
        ],
      }),
    );
    expect(answerFor(result, "why").value).toBe("Acme-specific answer.");
  });

  it("does not match unrelated questions", async () => {
    const result = await resolveAnswers(
      [field({ id: "stake", label: "Describe a challenging stakeholder situation", kind: "textarea" })],
      sampleProfile({ qaBank: [whyEntry] }),
    );
    expect(result.answers).toEqual([]);
    expect(openFor(result, "stake").reason).toContain("No profile field");
  });

  it("ignores unapproved entries even on an exact match", async () => {
    const result = await resolveAnswers(
      [field({ id: "stake", label: "Describe a challenging stakeholder situation", kind: "textarea" })],
      sampleProfile({
        qaBank: [
          {
            question: "Describe a challenging stakeholder situation",
            answer: "Draft the user never approved.",
            approved: false,
            uses: 0,
          },
        ],
      }),
    );
    expect(result.answers).toEqual([]);
    expect(openFor(result, "stake").fieldId).toBe("stake");
  });

  it("requires qa answers on option fields to land on an offered choice", async () => {
    const select = field({
      id: "notice-sel",
      label: "How much notice do you need to give?",
      kind: "select",
      options: ["1 week", "2 weeks", "1 month"],
    });
    const fits = await resolveAnswers(
      [select],
      sampleProfile({
        qaBank: [
          {
            question: "How much notice do you need to give your employer?",
            answer: "2 weeks",
            approved: true,
            uses: 1,
          },
        ],
      }),
    );
    const answer = answerFor(fits, "notice-sel");
    expect(answer.value).toBe("2 weeks");
    expect(answer.source).toBe("qa_bank");

    const misfits = await resolveAnswers(
      [select],
      sampleProfile({
        qaBank: [
          {
            question: "How much notice do you need to give your employer?",
            answer: "Immediately available",
            approved: true,
            uses: 1,
          },
        ],
      }),
    );
    expect(misfits.answers).toEqual([]);
    expect(openFor(misfits, "notice-sel").fieldId).toBe("notice-sel");
  });

  it("coerces yes/no qa answers to booleans for checkboxes", async () => {
    const result = await resolveAnswers(
      [field({ id: "privacy", label: "I agree to the Privacy Policy", kind: "checkbox" })],
      sampleProfile({
        qaBank: [
          { question: "Do you agree to the privacy policy?", answer: "Yes", approved: true, uses: 0 },
        ],
      }),
    );
    expect(answerFor(result, "privacy").value).toBe(true);
  });

  it("does not mutate the profile (uses counters stay untouched)", async () => {
    const profile = sampleProfile({ qaBank: [whyEntry] });
    const snapshot = JSON.parse(JSON.stringify(profile)) as unknown;
    await resolveAnswers(
      [field({ id: "why", label: "Why do you want to work at Acme?", kind: "textarea" })],
      profile,
    );
    expect(profile).toEqual(snapshot);
    expect(profile.qaBank[0]?.uses).toBe(2);
  });
});

describe("resolveAnswers: LLM delegate", () => {
  const terraform = field({
    id: "tf",
    label: "Describe your experience with Terraform",
    kind: "textarea",
  });

  it("uses a confident delegate answer with source 'llm'", async () => {
    const delegate: AnswerDelegate = async () => ({
      value: "Three years managing Terraform stacks.",
      confident: true,
    });
    const result = await resolveAnswers([terraform], sampleProfile(), delegate);
    const answer = answerFor(result, "tf");
    expect(answer.value).toBe("Three years managing Terraform stacks.");
    expect(answer.source).toBe("llm");
  });

  it("queues the field when the delegate is not confident", async () => {
    const delegate: AnswerDelegate = async () => ({ value: "Maybe?", confident: false });
    const result = await resolveAnswers([terraform], sampleProfile(), delegate);
    expect(result.answers).toEqual([]);
    expect(openFor(result, "tf").reason).toContain("not confident");
  });

  it("queues the field when the delegate declines with null", async () => {
    const delegate: AnswerDelegate = async () => null;
    const result = await resolveAnswers([terraform], sampleProfile(), delegate);
    expect(openFor(result, "tf").reason).toContain("declined");
  });

  it("queues the field when the delegate throws, without breaking other fields", async () => {
    const delegate: AnswerDelegate = async (f) => {
      if (f.id === "tf") throw new Error("provider down");
      return null;
    };
    const result = await resolveAnswers(
      [terraform, field({ id: "full", label: "Full name", kind: "text" })],
      sampleProfile(),
      delegate,
    );
    expect(openFor(result, "tf").reason).toContain("error");
    expect(answerFor(result, "full").value).toBe("Alex Chen");
  });

  it("is not consulted for fields resolved earlier, nor for file fields", async () => {
    const seen: string[] = [];
    const delegate: AnswerDelegate = async (f) => {
      seen.push(f.id);
      return null;
    };
    const result = await resolveAnswers(
      [
        field({ id: "email", label: "Email", kind: "email" }),
        field({ id: "cv", label: "Resume/CV", kind: "file" }),
      ],
      sampleProfile({ resumes: [] }),
      delegate,
    );
    expect(seen).toEqual([]);
    expect(answerFor(result, "email").value).toBe("alex@example.com");
    expect(openFor(result, "cv").reason).toMatch(/resume/i);
  });
});

describe("resolveAnswers: needsUser queueing", () => {
  it("passes options through to the open question", async () => {
    const options = ["LinkedIn", "Referral", "Other"];
    const result = await resolveAnswers(
      [field({ id: "source", label: "How did you hear about us?", kind: "select", options })],
      sampleProfile(),
    );
    const open = openFor(result, "source");
    expect(open.label).toBe("How did you hear about us?");
    expect(open.options).toEqual(options);
    expect(open.reason).toContain("No profile field");
  });

  it("lands every field in exactly one of answers or needsUser", async () => {
    const fields = [
      field({ id: "full", label: "Full name", kind: "text" }),
      field({ id: "cv", label: "Resume/CV", kind: "file" }),
      field({ id: "sponsor", label: "Do you require sponsorship?", kind: "yesno" }),
      field({ id: "mystery", label: "Favourite ice cream flavour", kind: "text" }),
      field({ id: "source", label: "How did you hear about us?", kind: "select", options: ["A", "B"] }),
    ];
    const result = await resolveAnswers(fields, sampleProfile());
    expect(result.answers.length + result.needsUser.length).toBe(fields.length);
    const ids = [
      ...result.answers.map((a) => a.fieldId),
      ...result.needsUser.map((q) => q.fieldId),
    ].sort();
    expect(ids).toEqual(fields.map((f) => f.id).sort());
  });
});
