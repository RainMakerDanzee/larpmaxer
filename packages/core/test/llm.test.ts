import { describe, expect, it } from "vitest";
import type { FormField, LlmMessage, LlmProvider, Profile, ResumeRef } from "../src/types.js";
import { makeLlmDelegate } from "../src/llm/answerDelegate.js";
import { UNKNOWN_ANSWER, buildAnswerMessages } from "../src/llm/prompts.js";
import { DEFAULT_MODELS, LlmError, createProvider, httpError } from "../src/llm/provider.js";

const resumeRef: ResumeRef = {
  id: "r1",
  filename: "alex-chen-data.pdf",
  mime: "application/pdf",
  tag: "data",
};

const profile: Profile = {
  name: "Alex Chen",
  email: "alex.chen@example.com",
  phone: "+61 400 111 222",
  location: "Sydney, NSW, Australia",
  links: [{ label: "GitHub", url: "https://github.com/alexchen" }],
  workRights: "Australian citizen",
  needsSponsorship: false,
  noticePeriod: "4 weeks",
  salary: "A$120,000",
  summary: "Data engineer focused on boring, reliable pipelines.",
  skills: ["SQL", "Python", "dbt"],
  experience: [
    {
      title: "Data Engineer",
      company: "Acme Analytics",
      start: "2021-03",
      end: "present",
      location: "Sydney",
      highlights: ["Built the ingestion platform used by 40 analysts."],
    },
  ],
  education: [{ institution: "UNSW", qualification: "BSc Computer Science", year: "2020" }],
  qaBank: [],
  resumes: [resumeRef],
};

const textField: FormField = {
  id: "why-us",
  kind: "textarea",
  label: "Why do you want to work here?",
  selector: "#why-us",
  required: true,
};

const optionField: FormField = {
  id: "work-rights",
  kind: "select",
  label: "What are your working rights in Australia?",
  selector: "#work-rights",
  required: true,
  options: ["Citizen or permanent resident", "Temporary visa with work rights", "No work rights"],
};

/** Canned-response provider that records every message batch it receives. */
function fakeProvider(reply: string): LlmProvider & { seen: LlmMessage[][] } {
  const seen: LlmMessage[][] = [];
  return {
    id: "anthropic",
    seen,
    async complete(messages) {
      seen.push(messages);
      return reply;
    },
  };
}

describe("buildAnswerMessages", () => {
  it("puts the only-profile-facts rule and the UNKNOWN escape hatch in the system prompt", () => {
    const [system] = buildAnswerMessages(textField, profile);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("Use ONLY facts present in the profile JSON");
    expect(system?.content).toContain(`reply with exactly ${UNKNOWN_ANSWER}`);
  });

  it("embeds the profile facts as JSON", () => {
    const [system] = buildAnswerMessages(textField, profile);
    expect(system?.content).toContain("alex.chen@example.com");
    expect(system?.content).toContain("Acme Analytics");
    expect(system?.content).toContain("Australian citizen");
  });

  it("describes the field and lists its options verbatim in the user message", () => {
    const [, user] = buildAnswerMessages(optionField, profile);
    expect(user?.role).toBe("user");
    expect(user?.content).toContain("What are your working rights in Australia?");
    for (const option of optionField.options ?? []) {
      expect(user?.content).toContain(`- ${option}`);
    }
  });

  it("strips stray resume bytes from the prompt", () => {
    const smuggled = { ...resumeRef, bytes: "U0VDUkVUX0JZVEVT" } as ResumeRef;
    const messages = buildAnswerMessages(textField, { ...profile, resumes: [smuggled] });
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("alex-chen-data.pdf");
    expect(serialized).not.toContain("U0VDUkVUX0JZVEVT");
    expect(serialized).not.toContain('\\"bytes\\"');
  });
});

describe("makeLlmDelegate", () => {
  it("maps UNKNOWN to null", async () => {
    const delegate = makeLlmDelegate(fakeProvider("UNKNOWN"));
    await expect(delegate(textField, profile)).resolves.toBeNull();
  });

  it("maps decorated UNKNOWN variants to null", async () => {
    const delegate = makeLlmDelegate(fakeProvider("Unknown."));
    await expect(delegate(textField, profile)).resolves.toBeNull();
  });

  it("maps an empty reply to null", async () => {
    const delegate = makeLlmDelegate(fakeProvider("   "));
    await expect(delegate(textField, profile)).resolves.toBeNull();
  });

  it("rejects a hallucinated option", async () => {
    const delegate = makeLlmDelegate(fakeProvider("Full unrestricted work rights"));
    await expect(delegate(optionField, profile)).resolves.toBeNull();
  });

  it("maps UNKNOWN on an option field to null", async () => {
    const delegate = makeLlmDelegate(fakeProvider("UNKNOWN"));
    await expect(delegate(optionField, profile)).resolves.toBeNull();
  });

  it("accepts an option case-insensitively and returns the form's casing, confident", async () => {
    const delegate = makeLlmDelegate(fakeProvider("citizen or permanent resident"));
    await expect(delegate(optionField, profile)).resolves.toEqual({
      value: "Citizen or permanent resident",
      confident: true,
    });
  });

  it("returns free-text answers trimmed and not confident", async () => {
    const delegate = makeLlmDelegate(fakeProvider("  I want to keep building reliable data platforms.  "));
    await expect(delegate(textField, profile)).resolves.toEqual({
      value: "I want to keep building reliable data platforms.",
      confident: false,
    });
  });

  it("sends the built prompt (system then user) to the provider", async () => {
    const provider = fakeProvider("UNKNOWN");
    await makeLlmDelegate(provider)(optionField, profile);
    const sent = provider.seen.at(0);
    expect(sent?.map((m) => m.role)).toEqual(["system", "user"]);
    expect(sent?.at(0)?.content).toContain("Use ONLY facts present in the profile JSON");
  });
});

describe("createProvider", () => {
  it("builds the provider matching the config", () => {
    const anthropic = createProvider({ provider: "anthropic", apiKey: "k", model: "" });
    const openai = createProvider({ provider: "openai", apiKey: "k", model: "" });
    expect(anthropic.id).toBe("anthropic");
    expect(openai.id).toBe("openai");
  });

  it("ships the expected default models", () => {
    expect(DEFAULT_MODELS).toEqual({ anthropic: "claude-sonnet-5", openai: "gpt-5.2" });
  });
});

describe("httpError", () => {
  it("maps 401 to a check-your-API-key message with the API detail", async () => {
    const err = await httpError("anthropic", {
      status: 401,
      text: async () => JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
    });
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(401);
    expect(err.provider).toBe("anthropic");
    expect(err.message).toContain("Check your API key");
    expect(err.message).toContain("invalid x-api-key");
  });

  it("survives a non-JSON error body", async () => {
    const err = await httpError("openai", { status: 503, text: async () => "Bad gateway" });
    expect(err.status).toBe(503);
    expect(err.message).toContain("try again");
  });
});
