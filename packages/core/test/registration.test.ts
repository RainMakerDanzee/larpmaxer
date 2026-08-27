import { describe, expect, it } from "vitest";
import { detectAuthWall, findAuthForm } from "../src/registration";

function doc(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe("detectAuthWall", () => {
  it("returns null on a page with no password field", () => {
    expect(detectAuthWall(doc(`<form><input type="email"></form>`))).toBeNull();
  });

  it("classifies two password boxes as registration", () => {
    const d = doc(`<form>
      <input type="email" id="em">
      <input type="password" id="p1"><input type="password" id="p2">
      <button type="submit">Continue</button></form>`);
    expect(detectAuthWall(d)).toBe("registration");
  });

  it("classifies autocomplete=new-password as registration", () => {
    const d = doc(`<form><input type="email" id="em">
      <input type="password" autocomplete="new-password">
      <button type="submit">Go</button></form>`);
    expect(detectAuthWall(d)).toBe("registration");
  });

  it("classifies a single password with a Sign in submit as login — even when the page links to registration", () => {
    const d = doc(`<div><a href="/register">Create an account</a>
      <form><input type="email" id="em"><input type="password" id="pw">
      <button type="submit">Sign in</button></form></div>`);
    expect(detectAuthWall(d)).toBe("login");
  });

  it("classifies a Create Account submit as registration", () => {
    const d = doc(`<form><input type="email" id="em"><input type="password" id="pw">
      <button type="submit">Create Account</button></form>`);
    expect(detectAuthWall(d)).toBe("registration");
  });
});

describe("findAuthForm", () => {
  it("locates email, both passwords, names and submit on an eziJob-style form", () => {
    const d = doc(`<form>
      <input type="text" name="firstname" placeholder="First Name">
      <input type="text" name="surname" placeholder="Surname">
      <input type="email" id="youremail">
      <input type="password" id="pw1"><input type="password" id="pw2">
      <button type="submit">Register</button></form>`);
    const f = findAuthForm(d)!;
    expect(f.kind).toBe("registration");
    expect(f.emailSelector).toBe("#youremail");
    expect(f.passwordSelectors).toEqual(["#pw1", "#pw2"]);
    expect(f.firstNameSelector).toBe('input[name="firstname"]');
    expect(f.lastNameSelector).toBe('input[name="surname"]');
    expect(f.submitSelector).toContain("button");
  });

  it("falls back to a username-style text input when no email input exists", () => {
    const d = doc(`<form><input type="text" name="username">
      <input type="password" id="pw"><button type="submit">Log in</button></form>`);
    const f = findAuthForm(d)!;
    expect(f.kind).toBe("login");
    expect(f.emailSelector).toBe('input[name="username"]');
  });

  it("returns null when there is a wall but no email-like input to fill", () => {
    const d = doc(`<form><input type="password" id="pw">
      <button type="submit">Sign in</button></form>`);
    expect(findAuthForm(d)).toBeNull();
  });
});
