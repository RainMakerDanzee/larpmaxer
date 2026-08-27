import { describe, expect, it } from "vitest";
import { findNextControl, pageSignature } from "../src/fill/pagination.js";

// DOMParser, as the adapter tests do: a windowless document, which is also the
// shape that catches realm-sensitive code.
const doc = (body: string): Document =>
  new DOMParser().parseFromString(`<!doctype html><body>${body}</body>`, "text/html");

describe("findNextControl", () => {
  it("finds a Next button", () => {
    const d = doc(`<button id="n">Next</button>`);
    expect(findNextControl(d)?.id).toBe("n");
  });

  it("finds Continue, Proceed and Save and continue", () => {
    for (const text of ["Continue", "Proceed", "Save and continue"]) {
      expect(findNextControl(doc(`<button id="n">${text}</button>`))?.id).toBe("n");
    }
  });

  it("reads the label off an input button's value", () => {
    expect(findNextControl(doc(`<input type="button" id="n" value="Next">`))?.id).toBe("n");
  });

  it("reads an aria-label when the control has no text", () => {
    expect(findNextControl(doc(`<button id="n" aria-label="Next step"></button>`))?.id).toBe("n");
  });

  it("honours an adapter's explicit selector over the text scan", () => {
    const d = doc(`<button id="wrong">Next</button><button id="right" class="wd-next">Onward</button>`);
    expect(findNextControl(d, ".wd-next")?.id).toBe("right");
  });

  it("returns null when the explicit selector matches nothing", () => {
    expect(findNextControl(doc(`<button>Next</button>`), ".nope")).toBeNull();
  });
});

// The whole point of the narrow match: clicking the wrong control sends a
// half-filled application, which is worse than filling nothing at all.
describe("findNextControl refuses anything that might submit", () => {
  it("never treats Submit as Next", () => {
    expect(findNextControl(doc(`<button id="s">Submit application</button>`))).toBeNull();
  });

  it("never treats Apply as Next", () => {
    expect(findNextControl(doc(`<button id="s">Apply now</button>`))).toBeNull();
  });

  it("rejects a control whose label reads both ways", () => {
    // "Continue" alone would pass; "submit" in the same label vetoes it.
    expect(findNextControl(doc(`<button id="s">Continue to submit</button>`))).toBeNull();
  });

  it("rejects Finish and Complete, which end the form", () => {
    for (const text of ["Finish", "Complete application"]) {
      expect(findNextControl(doc(`<button>${text}</button>`))).toBeNull();
    }
  });

  it("never goes backwards", () => {
    for (const text of ["Back", "Previous", "Cancel"]) {
      expect(findNextControl(doc(`<button>${text}</button>`))).toBeNull();
    }
  });

  it("skips a disabled Next and keeps looking", () => {
    const d = doc(`<button id="a" disabled>Next</button><button id="b">Next</button>`);
    expect(findNextControl(d)?.id).toBe("b");
  });

  it("skips an aria-disabled Next", () => {
    expect(findNextControl(doc(`<button aria-disabled="true">Next</button>`))).toBeNull();
  });

  it("skips a hidden Next", () => {
    expect(findNextControl(doc(`<button hidden>Next</button>`))).toBeNull();
  });

  it("finds nothing on a single-page form, rather than picking the submit", () => {
    const d = doc(`
      <form><input id="email"><input type="submit" value="Submit Application"></form>`);
    expect(findNextControl(d)).toBeNull();
  });

  it("picks Next on a page that has both Next and Submit", () => {
    const d = doc(`<button id="n">Next</button><input type="submit" value="Submit">`);
    expect(findNextControl(d)?.id).toBe("n");
  });
});

describe("pageSignature", () => {
  it("is order independent, so field order changes do not read as a new step", () => {
    expect(pageSignature(["a", "b"])).toBe(pageSignature(["b", "a"]));
  });

  it("differs when the step's fields differ", () => {
    expect(pageSignature(["a", "b"])).not.toBe(pageSignature(["a", "c"]));
  });

  it("treats an empty step as its own signature", () => {
    expect(pageSignature([])).toBe("");
  });
});

