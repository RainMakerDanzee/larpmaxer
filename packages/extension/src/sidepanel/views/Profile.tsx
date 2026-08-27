import { useEffect, useState } from "preact/hooks";
import { emptyProfile, extractResumeText, mergeIntoProfile, parseResume } from "@larpmaxer/core";
import type {
  Education,
  Experience,
  ParsedResume,
  Profile,
  QAEntry,
  ResumeRef,
} from "@larpmaxer/core";
import {
  deleteResumeBytes,
  getProfile,
  getResumeBytes,
  setProfile as persistProfile,
  storeResumeBytes,
} from "../../background/storage";
import { onMessage, sendToRuntime } from "../../lib/messaging";

/** A resume that has been read but not yet merged — the user confirms first. */
interface PendingImport {
  parsed: ParsedResume;
  /** Where it came from, for the card's heading. */
  from: string;
}

/** One line naming everything the parse actually found; nothing it didn't. */
function importSummary(p: ParsedResume): string {
  const parts: string[] = [];
  if (p.name !== undefined) parts.push("name");
  if (p.email !== undefined) parts.push("email");
  if (p.phone !== undefined) parts.push("phone");
  if (p.links.length > 0) parts.push(`${p.links.length} link${p.links.length === 1 ? "" : "s"}`);
  if (p.summary !== undefined) parts.push("summary");
  if (p.skills.length > 0) parts.push(`${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}`);
  if (p.experience.length > 0) {
    parts.push(`${p.experience.length} role${p.experience.length === 1 ? "" : "s"}`);
  }
  if (p.education.length > 0) {
    const n = p.education.length;
    parts.push(`${n} qualification${n === 1 ? "" : "s"}`);
  }
  return parts.length === 0 ? "nothing it could read confidently" : parts.join(", ");
}

/** Labelled single-line text input bound to one string value. */
function Field(props: {
  label: string;
  value: string;
  onValue: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder ?? ""}
        onInput={(e) => props.onValue(e.currentTarget.value)}
      />
    </label>
  );
}

/** Profile tab: edits every Profile field; explicit Save persists to chrome.storage.local. */
export function ProfileView() {
  const [profile, setProfile] = useState<Profile | null>(null);
  // Skills are edited as one comma-separated string and parsed on Save.
  const [skillsText, setSkillsText] = useState("");
  const [flash, setFlash] = useState("");
  // Resume import: read → confirm → merge. Never applied without the user.
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [importNote, setImportNote] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  // The LLM pass runs in the background worker and answers asynchronously.
  const [refining, setRefining] = useState(false);
  const [refineNote, setRefineNote] = useState("");

  useEffect(() => {
    void getProfile().then((stored) => {
      const p = stored ?? emptyProfile();
      setProfile(p);
      setSkillsText(p.skills.join(", "));
    });
  }, []);

  // The background answers every refinement request, successful or not, so the
  // "Improving..." state always resolves.
  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type !== "REFINE_RESUME_RESULT") return;
        setRefining(false);
        setRefineNote(msg.refined ? "" : (msg.note ?? ""));
        // Only replace a card the user has not already acted on.
        setPending((current) =>
          current === null ? null : { ...current, parsed: msg.parsed },
        );
      }),
    [],
  );

  if (!profile) return <p class="muted">Loading profile...</p>;

  const patch = (p: Partial<Profile>): void => setProfile({ ...profile, ...p });

  const setLink = (i: number, p: Partial<Profile["links"][number]>): void =>
    patch({ links: profile.links.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  const setExp = (i: number, p: Partial<Experience>): void =>
    patch({
      experience: profile.experience.map((x, j) => (j === i ? { ...x, ...p } : x)),
    });
  const setEdu = (i: number, p: Partial<Education>): void =>
    patch({
      education: profile.education.map((x, j) => (j === i ? { ...x, ...p } : x)),
    });
  const setQa = (i: number, p: Partial<QAEntry>): void =>
    patch({ qaBank: profile.qaBank.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const setResumeTag = (id: string, tag: string): void =>
    patch({ resumes: profile.resumes.map((r) => (r.id === id ? { ...r, tag } : r)) });

  const save = async (): Promise<void> => {
    const clean: Profile = {
      ...profile,
      skills: skillsText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
      experience: profile.experience.map((x) => ({
        ...x,
        highlights: x.highlights.map((h) => h.trim()).filter((h) => h !== ""),
      })),
    };
    if (clean.salary !== undefined && clean.salary.trim() === "") delete clean.salary;
    setProfile(clean);
    setSkillsText(clean.skills.join(", "));
    await persistProfile(clean);
    setFlash("Saved");
    window.setTimeout(() => setFlash(""), 1500);
  };

  /**
   * The profile as it stands in the editor right now.
   *
   * Skills live in their own text box until Save, so reading them back here
   * keeps an unsaved skills edit from looking empty to the merge — which would
   * then overwrite it from the resume.
   */
  const liveProfile = (): Profile => ({
    ...profile,
    skills: skillsText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  });

  /** Read bytes into a pending import, or explain why they could not be read. */
  const readResume = async (bytes: Uint8Array, filename: string): Promise<void> => {
    setPending(null);
    const result = await extractResumeText(bytes, filename);
    if (!result.ok) {
      setImportNote(result.message);
      setPasteOpen(true);
      return;
    }
    setImportNote("");
    setPasteOpen(false);
    startImport(parseResume(result.text), filename);
  };

  /**
   * Show the heuristic parse immediately, then ask the background to improve it.
   *
   * The heuristic result is always on screen first: refinement needs a network
   * round trip, and a parse the user can already act on should not wait on one.
   */
  const startImport = (parsed: ParsedResume, from: string): void => {
    setPending({ parsed, from });
    setRefineNote("");
    setRefining(true);
    void sendToRuntime({ type: "REFINE_RESUME_REQUEST", parsed });
  };

  // Uploads persist immediately: the bytes are already in storage, so the ref
  // must not be lost to an unsaved edit session.
  const addResume = async (file: File): Promise<void> => {
    const ref: ResumeRef = {
      id: crypto.randomUUID(),
      filename: file.name,
      mime: file.type === "" ? "application/octet-stream" : file.type,
    };
    const bytes = new Uint8Array(await file.arrayBuffer());
    await storeResumeBytes(ref.id, bytes);
    const next: Profile = { ...profile, resumes: [...profile.resumes, ref] };
    setProfile(next);
    await persistProfile(next);
    // The upload is safe on disk before anything is read from it, so a parse
    // that fails costs the user nothing.
    await readResume(bytes, file.name);
  };

  /** Re-read a resume already in storage — for files uploaded before this existed. */
  const readStoredResume = async (ref: ResumeRef): Promise<void> => {
    const bytes = await getResumeBytes(ref.id);
    if (bytes === undefined) {
      setImportNote(`"${ref.filename}" has no stored bytes — upload it again.`);
      return;
    }
    await readResume(bytes, ref.filename);
  };

  /**
   * Merge the pending import in. `mergeIntoProfile` fills only what is empty,
   * so this can never clobber something the user typed.
   */
  const applyImport = async (): Promise<void> => {
    if (!pending) return;
    const merged = mergeIntoProfile(pending.parsed, liveProfile());
    setProfile(merged);
    setSkillsText(merged.skills.join(", "));
    setPending(null);
    setImportNote("");
    setPasteOpen(false);
    setPasteText("");
    setRefining(false);
    setRefineNote("");
    await persistProfile(merged);
    setFlash("Filled from resume");
    window.setTimeout(() => setFlash(""), 2000);
  };

  /** Parse pasted text — the fallback for PDFs and anything else unreadable. */
  const readPastedText = (): void => {
    if (pasteText.trim() === "") return;
    setImportNote("");
    startImport(parseResume(pasteText), "pasted text");
  };

  const removeResume = async (id: string): Promise<void> => {
    await deleteResumeBytes(id);
    const next: Profile = {
      ...profile,
      resumes: profile.resumes.filter((r) => r.id !== id),
    };
    setProfile(next);
    await persistProfile(next);
  };

  return (
    <div class="stack">
      <div class="row">
        <button class="btn primary" onClick={() => void save()}>
          Save profile
        </button>
        {flash !== "" && <span class="flash">{flash}</span>}
      </div>

      <h2>Contact</h2>
      <Field label="Full name" value={profile.name} onValue={(v) => patch({ name: v })} />
      <div class="grid2">
        <Field
          label="Email"
          type="email"
          value={profile.email}
          onValue={(v) => patch({ email: v })}
        />
        <Field
          label="Phone"
          type="tel"
          value={profile.phone}
          onValue={(v) => patch({ phone: v })}
        />
      </div>
      <Field
        label="Location"
        value={profile.location}
        placeholder="City, State, Country"
        onValue={(v) => patch({ location: v })}
      />

      <h2>Work rights and logistics</h2>
      <Field
        label="Work rights"
        value={profile.workRights}
        placeholder="e.g. Australian permanent resident"
        onValue={(v) => patch({ workRights: v })}
      />
      <label class="check">
        <input
          type="checkbox"
          checked={profile.needsSponsorship}
          onChange={(e) => patch({ needsSponsorship: e.currentTarget.checked })}
        />
        I need visa sponsorship
      </label>
      <div class="grid2">
        <Field
          label="Notice period"
          value={profile.noticePeriod}
          placeholder="e.g. 4 weeks"
          onValue={(v) => patch({ noticePeriod: v })}
        />
        <Field
          label="Salary expectation (optional)"
          value={profile.salary ?? ""}
          placeholder="e.g. A$95,000-115,000"
          onValue={(v) => patch({ salary: v })}
        />
      </div>

      <h2>Summary and skills</h2>
      <label class="field">
        <span>Professional summary</span>
        <textarea
          value={profile.summary}
          onInput={(e) => patch({ summary: e.currentTarget.value })}
        />
      </label>
      <label class="field">
        <span>Skills (comma-separated)</span>
        <input
          type="text"
          value={skillsText}
          onInput={(e) => setSkillsText(e.currentTarget.value)}
        />
      </label>

      <h2>Links</h2>
      <div class="repeater">
        {profile.links.map((l, i) => (
          <div key={i} class="item">
            <div class="grid2">
              <Field
                label="Label"
                value={l.label}
                placeholder="LinkedIn"
                onValue={(v) => setLink(i, { label: v })}
              />
              <Field
                label="URL"
                value={l.url}
                placeholder="https://"
                onValue={(v) => setLink(i, { url: v })}
              />
            </div>
            <div class="row">
              <button
                class="btn danger"
                onClick={() => patch({ links: profile.links.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <div class="row">
          <button
            class="btn"
            onClick={() => patch({ links: [...profile.links, { label: "", url: "" }] })}
          >
            Add link
          </button>
        </div>
      </div>

      <h2>Experience</h2>
      <div class="repeater">
        {profile.experience.map((x, i) => (
          <div key={i} class="item">
            <div class="grid2">
              <Field label="Title" value={x.title} onValue={(v) => setExp(i, { title: v })} />
              <Field
                label="Company"
                value={x.company}
                onValue={(v) => setExp(i, { company: v })}
              />
              <Field
                label="Start (YYYY-MM)"
                value={x.start}
                placeholder="2021-03"
                onValue={(v) => setExp(i, { start: v })}
              />
              <Field
                label="End (YYYY-MM or present)"
                value={x.end}
                placeholder="present"
                onValue={(v) => setExp(i, { end: v })}
              />
            </div>
            <Field
              label="Location (optional)"
              value={x.location ?? ""}
              onValue={(v) => setExp(i, { location: v })}
            />
            <label class="field">
              <span>Highlights (one per line)</span>
              <textarea
                value={x.highlights.join("\n")}
                onInput={(e) => setExp(i, { highlights: e.currentTarget.value.split("\n") })}
              />
            </label>
            <div class="row">
              <button
                class="btn danger"
                onClick={() =>
                  patch({ experience: profile.experience.filter((_, j) => j !== i) })
                }
              >
                Remove role
              </button>
            </div>
          </div>
        ))}
        <div class="row">
          <button
            class="btn"
            onClick={() =>
              patch({
                experience: [
                  ...profile.experience,
                  { title: "", company: "", start: "", end: "", highlights: [] },
                ],
              })
            }
          >
            Add role
          </button>
        </div>
      </div>

      <h2>Education</h2>
      <div class="repeater">
        {profile.education.map((ed, i) => (
          <div key={i} class="item">
            <div class="grid2">
              <Field
                label="Institution"
                value={ed.institution}
                onValue={(v) => setEdu(i, { institution: v })}
              />
              <Field
                label="Qualification"
                value={ed.qualification}
                onValue={(v) => setEdu(i, { qualification: v })}
              />
            </div>
            <div class="grid2">
              <Field
                label="Year (optional)"
                value={ed.year ?? ""}
                onValue={(v) => setEdu(i, { year: v })}
              />
              <Field
                label="Notes (optional)"
                value={ed.notes ?? ""}
                onValue={(v) => setEdu(i, { notes: v })}
              />
            </div>
            <div class="row">
              <button
                class="btn danger"
                onClick={() =>
                  patch({ education: profile.education.filter((_, j) => j !== i) })
                }
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <div class="row">
          <button
            class="btn"
            onClick={() =>
              patch({
                education: [
                  ...profile.education,
                  { institution: "", qualification: "" },
                ],
              })
            }
          >
            Add education
          </button>
        </div>
      </div>

      <h2>My answers (Q&amp;A bank)</h2>
      <p class="muted small">
        Reusable answers to screening questions. Approved wording can be filled
        without asking you again.
      </p>
      <div class="repeater">
        {profile.qaBank.map((q, i) => (
          <div key={i} class="item">
            <Field
              label="Question"
              value={q.question}
              placeholder="Do you require sponsorship?"
              onValue={(v) => setQa(i, { question: v })}
            />
            <label class="field">
              <span>Answer</span>
              <textarea
                value={q.answer}
                onInput={(e) => setQa(i, { answer: e.currentTarget.value })}
              />
            </label>
            <div class="row">
              <label class="check">
                <input
                  type="checkbox"
                  checked={q.approved}
                  onChange={(e) => setQa(i, { approved: e.currentTarget.checked })}
                />
                Approved wording
              </label>
              <span class="muted small">Used {q.uses} times</span>
              <button
                class="btn danger"
                onClick={() => patch({ qaBank: profile.qaBank.filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <div class="row">
          <button
            class="btn"
            onClick={() =>
              patch({
                qaBank: [
                  ...profile.qaBank,
                  { question: "", answer: "", approved: false, uses: 0 },
                ],
              })
            }
          >
            Add answer
          </button>
        </div>
      </div>

      <h2>Resumes</h2>

      {pending && (
        <div class="card intake">
          <strong class="card-title">Read from {pending.from}</strong>
          <p class="small">
            Found {importSummary(pending.parsed)}. Filling only fills fields you have left
            empty — nothing you have typed is overwritten.
          </p>
          {refining && <p class="muted small">Improving the read with your model...</p>}
          {refineNote !== "" && <p class="muted small">{refineNote}</p>}
          <div class="row">
            <button class="btn primary" onClick={() => void applyImport()}>
              Fill empty fields
            </button>
            <button
              class="btn"
              onClick={() => {
                setPending(null);
                setRefining(false);
                setRefineNote("");
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {importNote !== "" && <p class="warn small">{importNote}</p>}

      <div class="repeater">
        {profile.resumes.map((r) => (
          <div key={r.id} class="item">
            <div class="row">
              <strong class="small">{r.filename}</strong>
              <span class="muted small">{r.mime}</span>
            </div>
            <Field
              label="Tag (job family, e.g. data)"
              value={r.tag ?? ""}
              onValue={(v) => setResumeTag(r.id, v)}
            />
            <div class="row">
              <button class="btn" onClick={() => void readStoredResume(r)}>
                Fill profile from this
              </button>
              <button class="btn danger" onClick={() => void removeResume(r.id)}>
                Remove
              </button>
            </div>
          </div>
        ))}
        <label class="field">
          <span>Upload resume (stored only in this browser)</span>
          <input
            type="file"
            accept=".pdf,.doc,.docx,.txt,.md"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void addResume(file);
            }}
          />
        </label>
      </div>

      <div class="stack">
        {!pasteOpen && (
          <button class="btn" onClick={() => setPasteOpen(true)}>
            Or paste your resume text
          </button>
        )}
        {pasteOpen && (
          <label class="field">
            <span>Paste your resume text</span>
            <textarea
              rows={8}
              value={pasteText}
              placeholder="Select all in your PDF viewer, copy, and paste here"
              onInput={(e) => setPasteText(e.currentTarget.value)}
            />
          </label>
        )}
        {pasteOpen && (
          <div class="row">
            <button class="btn primary" onClick={readPastedText} disabled={pasteText.trim() === ""}>
              Read this text
            </button>
            <button
              class="btn"
              onClick={() => {
                setPasteOpen(false);
                setPasteText("");
                setImportNote("");
              }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      <div class="row">
        <button class="btn primary" onClick={() => void save()}>
          Save profile
        </button>
        {flash !== "" && <span class="flash">{flash}</span>}
      </div>
    </div>
  );
}
