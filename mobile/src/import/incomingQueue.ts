import type { SourceFile } from "../fog/store.js";

const queue: SourceFile[] = [];
const listeners: Array<(file: SourceFile) => void> = [];

export function enqueueIncoming(file: SourceFile): void {
  if (listeners.length > 0) {
    for (const l of listeners) l(file);
  } else {
    queue.push(file);
  }
}

export function subscribeIncoming(listener: (file: SourceFile) => void): () => void {
  for (const f of queue.splice(0)) listener(f);
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i !== -1) listeners.splice(i, 1);
  };
}
