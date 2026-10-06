export interface StatusActions {
  update(): void;
  clear(): void;
  about(): void;
  retry(): void;
}

export interface Status {
  showSaved(copy: { name: string; savedAt: string }): void;
  showProgress(receivedBytes: number, totalBytes: number): void;
  showRetry(kind: "failed" | "suspended"): void;
  showNotice(text: string): void;
  hide(): void;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function ageLabel(days: number): string | null {
  if (days < 7) return null;
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  if (months >= 2) return `${months} months old`;
  return `${weeks} week${weeks === 1 ? "" : "s"} old`;
}

export function formatMb(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

function btn(label: string, action: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", action);
  return b;
}

export function createStatus(doc: Document, actions: StatusActions, now: () => number): Status {
  let container = doc.getElementById("crossfogStatus");
  if (container == null) {
    container = doc.createElement("div");
    container.id = "crossfogStatus";

    const line = doc.createElement("div");
    line.id = "crossfogLine";
    container.appendChild(line);

    const notice = doc.createElement("div");
    notice.id = "crossfogNotice";
    container.appendChild(notice);

    const style = doc.createElement("style");
    style.textContent = ".crossfog-stale { color: #b00; }";
    container.appendChild(style);

    const loadStatus = doc.getElementById("loadStatus");
    loadStatus?.insertAdjacentElement("afterend", container);
  }

  const lineEl = doc.getElementById("crossfogLine")!;
  const noticeEl = doc.getElementById("crossfogNotice")!;
  const hintEl = doc.getElementById("hint");
  const hintText = hintEl?.textContent ?? "";

  function restoreHint(): void {
    if (hintEl != null) hintEl.textContent = hintText;
  }

  return {
    showSaved({ name, savedAt }) {
      restoreHint();
      lineEl.textContent = "";
      const days = Math.floor((now() - Date.parse(savedAt)) / 86_400_000);
      const age = ageLabel(days);
      const dateFmt = formatDate(savedAt);

      const prefix = doc.createElement("span");
      prefix.textContent = `Saved backup ${name}, imported `;
      lineEl.appendChild(prefix);

      if (age != null) {
        const stale = doc.createElement("span");
        stale.className = "crossfog-stale";
        stale.textContent = `${dateFmt} (${age})`;
        lineEl.appendChild(stale);
      } else {
        lineEl.appendChild(doc.createTextNode(dateFmt));
      }

      lineEl.appendChild(doc.createTextNode(" · "));
      lineEl.appendChild(btn("Update", actions.update));
      lineEl.appendChild(doc.createTextNode(" · "));
      lineEl.appendChild(btn("Clear saved fog", actions.clear));
      lineEl.appendChild(doc.createTextNode(" · "));
      lineEl.appendChild(btn("About", actions.about));
    },

    showProgress(receivedBytes, totalBytes) {
      const amount = `${formatMb(receivedBytes)} / ${formatMb(totalBytes)} MB`;
      lineEl.textContent = `Loading your fog… ${amount}`;
      if (hintEl != null) hintEl.textContent = `Loading… ${amount}`;
    },

    showRetry(kind) {
      restoreHint();
      lineEl.textContent = "";
      const msg = doc.createElement("span");
      msg.textContent =
        kind === "suspended"
          ? "Your saved fog couldn't be opened. The last attempt ran out of memory."
          : "Your saved fog couldn't be opened.";
      lineEl.appendChild(msg);
      lineEl.appendChild(doc.createTextNode(" "));
      lineEl.appendChild(btn("Retry", actions.retry));
      lineEl.appendChild(doc.createTextNode(" · "));
      lineEl.appendChild(btn("Choose another backup", actions.update));
      lineEl.appendChild(doc.createTextNode(" · "));
      lineEl.appendChild(btn("Clear saved fog", actions.clear));
    },

    showNotice(text) {
      noticeEl.textContent = text;
    },

    hide() {
      restoreHint();
      lineEl.textContent = "";
    },
  };
}
