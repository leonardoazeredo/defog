export const MIN_PASSPHRASE_CHARS = 8;

export type PassphraseAnswer = { kind: "passphrase"; passphrase: string } | { kind: "none" };

type FormProblem = "tooShort" | "rawKey" | "mismatch";

// SQLCipher reads x'<64 hex>' as the raw cipher secret and x'<96 hex>' as that plus a salt, not as a passphrase to stretch,
// so the text would be used as typed with no derivation step (see db/driver.ts).
const RAW_KEY_FORM = /^x'([0-9a-f]{64}|[0-9a-f]{96})'$/i;

export interface BackupFormState {
  problem: FormProblem | null;
  /** The answer to hand back; null while the form cannot be submitted. */
  answer: PassphraseAnswer | null;
  /** The warning that an unencrypted file can be read by anyone is shown as soon as "No encryption" is ticked. */
  showWarning: boolean;
}

export function backupFormState(input: {
  passphrase: string;
  confirm: string;
  noEncryption: boolean;
}): BackupFormState {
  if (input.noEncryption) return { problem: null, answer: { kind: "none" }, showWarning: true };
  if (input.passphrase.length < MIN_PASSPHRASE_CHARS) {
    return { problem: "tooShort", answer: null, showWarning: false };
  }
  if (RAW_KEY_FORM.test(input.passphrase)) {
    return { problem: "rawKey", answer: null, showWarning: false };
  }
  if (input.passphrase !== input.confirm) {
    return { problem: "mismatch", answer: null, showWarning: false };
  }
  return {
    problem: null,
    answer: { kind: "passphrase", passphrase: input.passphrase },
    showWarning: false,
  };
}

/** A restore takes any non-empty text: the length rule applied when the backup was made, not now. */
export function restoreFormAnswer(passphrase: string): PassphraseAnswer | null {
  return passphrase.length === 0 ? null : { kind: "passphrase", passphrase };
}
