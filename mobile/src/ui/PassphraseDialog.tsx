import { useState } from "react";
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { COPY } from "../copy.js";
import { backupFormState, type PassphraseAnswer, restoreFormAnswer } from "./passphraseForm.js";

export interface PassphraseRequest {
  mode: "backup" | "restore";
  resolve(answer: PassphraseAnswer | null): void;
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  card: { backgroundColor: "#fff", borderRadius: 14, padding: 20, gap: 12 },
  title: { fontSize: 18, fontWeight: "600" },
  body: { fontSize: 14, color: "#333" },
  warning: { fontSize: 14, color: "#8a1c1c" },
  problem: { fontSize: 13, color: "#8a1c1c" },
  input: { borderWidth: 1, borderColor: "#999", borderRadius: 8, padding: 10, fontSize: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", gap: 20, marginTop: 4 },
  button: { fontSize: 16, fontWeight: "600", color: "#1b5fc1", padding: 6 },
  disabled: { color: "#999" },
});

// The passphrase is typed here and nowhere else: it never goes into the page.
const noSuggestions = {
  secureTextEntry: true,
  autoCorrect: false,
  autoCapitalize: "none",
  autoComplete: "off",
  importantForAutofill: "no",
  spellCheck: false,
} as const;

// The form mounts only while a request is open, so each request starts empty and a finished one leaves nothing typed behind.
export function PassphraseDialog({
  request,
}: {
  request: PassphraseRequest | null;
}): React.JSX.Element | null {
  return request === null ? null : <PassphraseForm request={request} />;
}

function PassphraseForm({ request }: { request: PassphraseRequest }): React.JSX.Element {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [noEncryption, setNoEncryption] = useState(false);
  const backup = request.mode === "backup";
  const form = backupFormState({ passphrase, confirm, noEncryption });
  const answer = backup ? form.answer : restoreFormAnswer(passphrase);

  return (
    <Modal transparent animationType="fade" onRequestClose={() => request.resolve(null)}>
      <View style={styles.scrim}>
        <View style={styles.card}>
          <Text style={styles.title}>
            {backup ? COPY.passphraseBackupTitle : COPY.passphraseRestoreTitle}
          </Text>
          <Text style={styles.body}>
            {backup ? COPY.passphraseBackupLoss : COPY.passphraseRestoreLoss}
          </Text>
          {backup && noEncryption ? null : (
            <TextInput
              style={styles.input}
              value={passphrase}
              onChangeText={setPassphrase}
              placeholder={COPY.passphraseLabel}
              accessibilityLabel={COPY.passphraseLabel}
              {...noSuggestions}
            />
          )}
          {backup && !noEncryption ? (
            <TextInput
              style={styles.input}
              value={confirm}
              onChangeText={setConfirm}
              placeholder={COPY.passphraseConfirmLabel}
              accessibilityLabel={COPY.passphraseConfirmLabel}
              {...noSuggestions}
            />
          ) : null}
          {backup && passphrase.length > 0 && form.problem !== null ? (
            <Text style={styles.problem}>
              {form.problem === "tooShort" ? COPY.passphraseTooShort : COPY.passphraseMismatch}
            </Text>
          ) : null}
          {backup ? (
            <View style={styles.row}>
              <Switch
                value={noEncryption}
                onValueChange={setNoEncryption}
                accessibilityLabel={COPY.noEncryption}
              />
              <Text style={styles.body}>{COPY.noEncryption}</Text>
            </View>
          ) : null}
          {form.showWarning && backup ? (
            <Text style={styles.warning}>{COPY.unencryptedWarning}</Text>
          ) : null}
          <View style={styles.buttons}>
            <Pressable onPress={() => request.resolve(null)} accessibilityRole="button">
              <Text style={styles.button}>{COPY.cancel}</Text>
            </Pressable>
            <Pressable
              disabled={answer === null}
              onPress={() => answer !== null && request.resolve(answer)}
              accessibilityRole="button"
            >
              <Text style={[styles.button, answer === null && styles.disabled]}>
                {backup ? COPY.save : COPY.restore}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
