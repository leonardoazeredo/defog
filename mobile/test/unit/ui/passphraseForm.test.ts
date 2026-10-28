import { describe, expect, it } from "vitest";
import {
  backupFormState,
  MIN_PASSPHRASE_CHARS,
  restoreFormAnswer,
} from "../../../src/ui/passphraseForm.js";

const long = "x".repeat(MIN_PASSPHRASE_CHARS);

describe("backup form", () => {
  it("cannot be submitted with a short passphrase", () => {
    const s = backupFormState({
      passphrase: long.slice(1),
      confirm: long.slice(1),
      noEncryption: false,
    });
    expect(s).toEqual({ problem: "tooShort", answer: null, showWarning: false });
  });

  it.each([`x'${"ab".repeat(32)}'`, `X'${"AB".repeat(32)}'`, `x'${"aB09".repeat(16)}'`])(
    "rejects %s, which SQLCipher would read as a raw key",
    (raw) => {
      const s = backupFormState({ passphrase: raw, confirm: raw, noEncryption: false });
      expect(s).toEqual({ problem: "rawKey", answer: null, showWarning: false });
    },
  );

  it("rejects the 96-digit form with a salt too", () => {
    const raw = `x'${"ab".repeat(48)}'`;
    expect(backupFormState({ passphrase: raw, confirm: raw, noEncryption: false }).problem).toBe(
      "rawKey",
    );
  });

  it("accepts text that only looks like a raw key", () => {
    for (const p of [`x'${"ab".repeat(31)}'`, `x'${"zz".repeat(32)}'`, ` x'${"ab".repeat(32)}'`]) {
      expect(
        backupFormState({ passphrase: p, confirm: p, noEncryption: false }).problem,
      ).toBeNull();
    }
  });

  it("cannot be submitted when the two fields differ", () => {
    const s = backupFormState({ passphrase: long, confirm: `${long}!`, noEncryption: false });
    expect(s.problem).toBe("mismatch");
    expect(s.answer).toBeNull();
  });

  it("hands back the passphrase exactly as typed, spaces included", () => {
    const typed = ` ${long} `;
    const s = backupFormState({ passphrase: typed, confirm: typed, noEncryption: false });
    expect(s.answer).toEqual({ kind: "passphrase", passphrase: typed });
  });

  it("shows the unencrypted warning as soon as No encryption is ticked", () => {
    const s = backupFormState({ passphrase: "", confirm: "", noEncryption: true });
    expect(s).toEqual({ problem: null, answer: { kind: "none" }, showWarning: true });
  });

  it("ignores what was typed once No encryption is ticked", () => {
    const s = backupFormState({ passphrase: long, confirm: "other", noEncryption: true });
    expect(s.answer).toEqual({ kind: "none" });
  });
});

describe("restore form", () => {
  it("takes any non-empty text, however short", () => {
    expect(restoreFormAnswer("a")).toEqual({ kind: "passphrase", passphrase: "a" });
  });

  it("is not submittable when empty", () => {
    expect(restoreFormAnswer("")).toBeNull();
  });
});
