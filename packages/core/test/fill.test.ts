/**
 * @vitest-environment jsdom
 *
 * Fill-module tests: framework-proof value setting, file attach without a
 * real DataTransfer, label resolution, and the combobox dance.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clickOption,
  needsTrustedKeyboard,
  setCheckbox,
  setNativeValue,
} from "../src/fill/events";
import { attachFile } from "../src/fill/files";
import {
  comboboxSelect,
  findBySelector,
  labelFor,
  readBack,
  visible,
} from "../src/fill/dom";
import type { AdapterQuirks, FormField } from "../src/types";

// jsdom ships File but not DataTransfer; attachFile only touches items.add()
// and .files, so this minimal polyfill keeps the production code path intact.
class DataTransferPolyfill {
  readonly files: File[] = [];
  readonly items = {
    add: (file: File): void => {
      this.files.push(file);
    },
  };
}

if (typeof (window as { DataTransfer?: unknown }).DataTransfer === "undefined") {
  (window as unknown as { DataTransfer: unknown }).DataTransfer =
    DataTransferPolyfill;
}

/** Minimal FormField for quirk checks. */
function field(kind: FormField["kind"]): FormField {
  return { id: "f1", kind, label: "Test", selector: "#t", required: false };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("setNativeValue", () => {
  it("writes through the native setter, bypassing a React-style instance tracker", () => {
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.append(input);
    document.body.append(container);

    const native = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    if (!native?.get || !native.set) throw new Error("jsdom lost its value descriptor");
    const trackerSet = vi.fn();
    // Simulate React's value tracker: an instance-level descriptor that a
    // naive `input.value = x` would hit (suppressing onChange).
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => native.get!.call(input) as string,
      set: (v: string) => {
        trackerSet(v);
        native.set!.call(input, v);
      },
    });

    const events: string[] = [];
    // React listens at the root, so the events must bubble.
    container.addEventListener("input", (e) => events.push(`${e.type}:${e.bubbles}`));
    container.addEventListener("change", (e) => events.push(`${e.type}:${e.bubbles}`));

    setNativeValue(input, "Daniyal");

    expect(native.get!.call(input)).toBe("Daniyal"); // value really stored
    expect(trackerSet).not.toHaveBeenCalled(); // instance setter bypassed
    expect(events).toEqual(["input:true", "change:true"]);
  });

  it("works for textarea and select", () => {
    const ta = document.createElement("textarea");
    const sel = document.createElement("select");
    sel.innerHTML = `<option value="a">Option A</option><option value="b">Option B</option>`;
    document.body.append(ta, sel);

    const changed: string[] = [];
    sel.addEventListener("change", () => changed.push(sel.value));

    setNativeValue(ta, "cover letter text");
    setNativeValue(sel, "b");

    expect(ta.value).toBe("cover letter text");
    expect(sel.value).toBe("b");
    expect(changed).toEqual(["b"]);
  });
});

describe("setCheckbox", () => {
  it("clicks to reach the desired state and is idempotent", () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.append(box);
    const changes = vi.fn();
    box.addEventListener("change", changes);

    setCheckbox(box, true);
    expect(box.checked).toBe(true);
    const afterFirst = changes.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    setCheckbox(box, true); // already there: no extra events
    expect(changes.mock.calls.length).toBe(afterFirst);

    setCheckbox(box, false);
    expect(box.checked).toBe(false);
  });

  it("forces the property when a listener cancels the click", () => {
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.append(box);
    box.addEventListener("click", (e) => e.preventDefault());

    setCheckbox(box, true);
    expect(box.checked).toBe(true);
  });
});

describe("clickOption", () => {
  it("fires a full pointer sequence and activates radios", () => {
    document.body.innerHTML = `
      <input type="radio" name="g" id="r1" checked />
      <input type="radio" name="g" id="r2" />
    `;
    const r1 = document.getElementById("r1") as HTMLInputElement;
    const r2 = document.getElementById("r2") as HTMLInputElement;
    const seq: string[] = [];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      r2.addEventListener(type, () => seq.push(type));
    }

    clickOption(r2);

    expect(seq).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    expect(r2.checked).toBe(true);
    expect(r1.checked).toBe(false);
  });
});

describe("needsTrustedKeyboard", () => {
  it("flags exactly the kinds the adapter lists", () => {
    const quirks: AdapterQuirks = { trustedKeyboardOnly: ["text", "email"] };
    expect(needsTrustedKeyboard(field("text"), quirks)).toBe(true);
    expect(needsTrustedKeyboard(field("email"), quirks)).toBe(true);
    expect(needsTrustedKeyboard(field("file"), quirks)).toBe(false);
    expect(needsTrustedKeyboard(field("text"))).toBe(false);
    expect(needsTrustedKeyboard(field("text"), {})).toBe(false);
  });
});

describe("attachFile", () => {
  it("builds a File from bytes and lands it in input.files with input+change", () => {
    const input = document.createElement("input");
    input.type = "file";
    document.body.append(input);
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    attachFile(
      input,
      new Uint8Array([0x25, 0x50, 0x44, 0x46]), // "%PDF"
      "resume.pdf",
      "application/pdf",
    );

    expect(input.files?.[0]?.name).toBe("resume.pdf");
    expect(input.files?.[0]?.type).toBe("application/pdf");
    expect(input.files?.[0]?.size).toBe(4); // bytes made it through, no Buffer
    expect(events).toEqual(["input", "change"]);
  });

  it("rejects non-file inputs loudly", () => {
    const input = document.createElement("input"); // type=text
    document.body.append(input);
    expect(() =>
      attachFile(input, new Uint8Array(), "x.pdf", "application/pdf"),
    ).toThrow(/type="file"/);
  });
});

describe("labelFor", () => {
  const matrix: { name: string; html: string; expected: string }[] = [
    {
      name: "<label for>",
      html: `<label for="a">First name</label><input id="a" />`,
      expected: "First name",
    },
    {
      name: "aria-label",
      html: `<input id="a" aria-label="Email address" />`,
      expected: "Email address",
    },
    {
      name: "aria-labelledby with multiple ids",
      html: `<span id="p1">Phone</span><span id="p2">number</span><input id="a" aria-labelledby="p1 p2" />`,
      expected: "Phone number",
    },
    {
      name: "wrapping label",
      html: `<label>City\n  <input id="a" /></label>`,
      expected: "City",
    },
    {
      name: "preceding heading",
      html: `<h3>Work rights</h3><div><input id="a" /></div>`,
      expected: "Work rights",
    },
    {
      name: "nearest preceding heading",
      html: `<h2>Ignored</h2><h3>Diversity</h3><div><input id="a" /></div>`,
      expected: "Diversity",
    },
    {
      name: "heading after the control (ignored)",
      html: `<input id="a" /><h3>Later section</h3>`,
      expected: "",
    },
    { name: "nothing resolvable", html: `<input id="a" />`, expected: "" },
  ];

  for (const c of matrix) {
    it(`resolves via ${c.name}`, () => {
      document.body.innerHTML = c.html;
      const el = document.getElementById("a");
      if (!el) throw new Error("fixture missing #a");
      expect(labelFor(el)).toBe(c.expected);
    });
  }

  it("prefers <label for> over aria-label", () => {
    document.body.innerHTML = `<label for="a">Visible label</label><input id="a" aria-label="Aria label" />`;
    expect(labelFor(document.getElementById("a")!)).toBe("Visible label");
  });

  it("collapses whitespace", () => {
    document.body.innerHTML = `<label for="a">  Notice \n  period </label><input id="a" />`;
    expect(labelFor(document.getElementById("a")!)).toBe("Notice period");
  });
});

describe("visible", () => {
  it("reports rendered vs hidden controls", () => {
    document.body.innerHTML = `
      <input id="shown" />
      <input id="attr" hidden />
      <input id="css" style="display: none" />
      <input id="vis" style="visibility: hidden" />
      <div style="display: none"><input id="ancestor" /></div>
      <div hidden><input id="ancestorAttr" /></div>
      <input id="typed" type="hidden" />
    `;
    expect(visible(document.getElementById("shown")!)).toBe(true);
    expect(visible(document.getElementById("attr")!)).toBe(false);
    expect(visible(document.getElementById("css")!)).toBe(false);
    expect(visible(document.getElementById("vis")!)).toBe(false);
    expect(visible(document.getElementById("ancestor")!)).toBe(false);
    expect(visible(document.getElementById("ancestorAttr")!)).toBe(false);
    expect(visible(document.getElementById("typed")!)).toBe(false);
  });
});

describe("findBySelector", () => {
  it("returns the unique match and names the selector in every failure", () => {
    document.body.innerHTML = `<input id="one" /><input class="dup" /><input class="dup" />`;
    expect(findBySelector(document, "#one").id).toBe("one");
    expect(() => findBySelector(document, "#missing")).toThrow(
      /#missing" matched nothing/,
    );
    expect(() => findBySelector(document, ".dup")).toThrow(/matched 2 elements/);
    expect(() => findBySelector(document, "??")).toThrow(/invalid selector/);
  });
});

describe("readBack", () => {
  it("reads text, checkbox, textarea, select and ARIA states as strings", () => {
    document.body.innerHTML = `
      <input id="t" value="hello" />
      <input id="c" type="checkbox" checked />
      <input id="u" type="checkbox" />
      <textarea id="ta">essay</textarea>
      <select id="s"><option value="1">First choice</option><option value="2" selected>Second choice</option></select>
      <div id="w" role="checkbox" aria-checked="true"></div>
    `;
    expect(readBack(document.getElementById("t")!)).toBe("hello");
    expect(readBack(document.getElementById("c")!)).toBe("true");
    expect(readBack(document.getElementById("u")!)).toBe("false");
    expect(readBack(document.getElementById("ta")!)).toBe("essay");
    expect(readBack(document.getElementById("s")!)).toBe("Second choice");
    expect(readBack(document.getElementById("w")!)).toBe("true");
  });

  it("reads attached filenames from file inputs", () => {
    const input = document.createElement("input");
    input.type = "file";
    document.body.append(input);
    attachFile(input, new Uint8Array([1]), "resume.pdf", "application/pdf");
    expect(readBack(input)).toBe("resume.pdf");
  });
});

describe("comboboxSelect", () => {
  /** Fake ATS combobox: options render only after the user "types". */
  function mountCombobox(optionTexts: string[]): {
    input: HTMLInputElement;
    clicks: string[];
  } {
    document.body.innerHTML = `<label for="loc">Location</label><input id="loc" role="combobox" />`;
    const input = document.getElementById("loc") as HTMLInputElement;
    const clicks: string[] = [];
    input.addEventListener("input", () => {
      document.querySelector('[role="listbox"]')?.remove();
      const box = document.createElement("ul");
      box.setAttribute("role", "listbox");
      for (const text of optionTexts) {
        const opt = document.createElement("li");
        opt.setAttribute("role", "option");
        opt.textContent = text;
        opt.addEventListener("click", () => {
          clicks.push(text);
          input.value = text; // the page's own commit
          box.remove();
        });
        box.append(opt);
      }
      document.body.append(box);
    });
    return { input, clicks };
  }

  it("types, finds the matching option in the listbox, and clicks it", async () => {
    const { input, clicks } = mountCombobox(["Sydney NSW", "Melbourne VIC"]);
    await comboboxSelect(document, input, "Sydney NSW");
    expect(clicks).toEqual(["Sydney NSW"]);
    expect(input.value).toBe("Sydney NSW");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("matches case-insensitively and via unique substring", async () => {
    const { input, clicks } = mountCombobox(["Sydney NSW", "Melbourne VIC"]);
    await comboboxSelect(document, input, "melbourne");
    expect(clicks).toEqual(["Melbourne VIC"]);
  });

  it("throws on ambiguous partial matches", async () => {
    const { input } = mountCombobox(["Sydney NSW", "Sydney West"]);
    await expect(
      comboboxSelect(document, input, "sydney", { timeoutMs: 100, pollMs: 10 }),
    ).rejects.toThrow(/ambiguous/);
  });

  it("fails with the options it saw when nothing matches", async () => {
    const { input } = mountCombobox(["Sydney NSW"]);
    await expect(
      comboboxSelect(document, input, "Perth WA", { timeoutMs: 120, pollMs: 20 }),
    ).rejects.toThrow(/no combobox option matching "Perth WA".*Sydney NSW/);
  });

  it("waits for a listbox that renders asynchronously", async () => {
    document.body.innerHTML = `<input id="loc" role="combobox" />`;
    const input = document.getElementById("loc") as HTMLInputElement;
    input.addEventListener("input", () => {
      setTimeout(() => {
        const box = document.createElement("div");
        box.setAttribute("role", "listbox");
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.textContent = "Sydney NSW";
        opt.addEventListener("click", () => {
          input.value = "Sydney NSW";
        });
        box.append(opt);
        document.body.append(box);
      }, 60);
    });

    await comboboxSelect(document, input, "Sydney NSW", { pollMs: 10 });
    expect(input.value).toBe("Sydney NSW");
  });
});
