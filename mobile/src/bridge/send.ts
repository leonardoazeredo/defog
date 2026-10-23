import { encode, type NativeToWeb } from "./protocol.js";

export interface SendDeps {
  post(raw: string): void;
  /** Runs `fn` as a new React Native event-loop task; `scheduleTask` in the app. */
  schedule(fn: () => void): void;
}

// A timer is a RuntimeScheduler task. A microtask (`queueMicrotask`, `Promise.then`) is not: it
// runs inside the same off-scheduler drain and releases nothing.
export const scheduleTask = (fn: () => void): void => {
  setTimeout(fn, 0);
};

// Expo Modules v2 (expo-sqlite, expo-crypto) settles its promises on the JS thread outside React
// Native's RuntimeScheduler, so code after such an `await` runs outside an event-loop task. A
// WebView postMessage is a Fabric view command, which waits until the end of the next task: without
// a task of its own it reached the page only when the page next posted something (issue #139).
export function createSend(deps: SendDeps): (msg: NativeToWeb) => void {
  // Empty on purpose: the timer's task is what lets the posted message out.
  const yieldTask = () => undefined;
  return (msg) => {
    deps.post(encode(msg));
    deps.schedule(yieldTask);
  };
}
