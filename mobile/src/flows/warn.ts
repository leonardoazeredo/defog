// Only the error's class is logged: messages, ids and paths can tie a walk or a route to a time and
// a place, and a log line is not private. `scope` and `what` are logged as given: pass fixed strings.
export function warnClass(scope: string, what: string, e: unknown): void {
  console.warn(`crossfog: ${scope} ${what}`, e instanceof Error ? e.name : "unknown");
}
