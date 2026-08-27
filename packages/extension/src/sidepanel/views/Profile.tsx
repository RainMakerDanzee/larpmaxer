import { useEffect, useState } from "preact/hooks";
import { emptyProfile } from "@larpmaxer/core";
import type {
  Education,
  Experience,
  Profile,
  QAEntry,
  ResumeRef,
} from "@larpmaxer/core";
import {
  deleteResumeBytes,
  getProfile,
  setProfile as persistProfile,
  storeResumeBytes,
} from "../../background/storage";

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

  useEffect(() => {
    void getProfile().then((stored) => {
      const p = stored ?? emptyProfile();
      setProfile(p);
      setSkillsText(p.skills.join(", "));
    });
  }, []);

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

  // Uploads persist immediately: the bytes are already in storage, so the ref
  // must not be lost to an unsaved edit session.
  const addResume = async (file: File): Promise<void> => {
    const ref: ResumeRef = {
      id: crypto.randomUUID(),
      filename: file.name,
      mime: file.type === "" ? "application/octet-stream" : file.type,
    };
    await storeResumeBytes(ref.id, new Uint8Array(await file.arrayBuffer()));
    const next: Profile = { ...profile, resumes: [...profile.resumes, ref] };
    setProfile(next);
    await persistProfile(next);
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
      <div class="repeater">
        {profile.resumes.map((r) => (
          <div key={r.id} class="item">
            <div class="row">
              <strong class="small">{r.filename}</strong>
              <span class="muted small">{r.mime}</span>
            </div>
            <div class="row">
              <Field
                label="Tag (job family, e.g. data)"
                value={r.tag ?? ""}
                onValue={(v) => setResumeTag(r.id, v)}
              />
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
            accept=".pdf,.doc,.docx"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void addResume(file);
            }}
          />
        </label>
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
