import { inject } from "vitest";

// Stryker 10 + vitest compatibility shim.
//
// stryker-setup.js stores mutation state on globalThis.__stryker__.
// The instrumented source's namespace-capture function (stryNS_*) captures
// ns = globalThis.__stryker__ at module load time, before beforeAll() fires.
// We replace g.__stryker__ with
// a Proxy so activeMutant always reflects the value inject() gave us,
// regardless of when the instrumented code read the reference.
const mode = inject("mode");
const activeMutant = inject("activeMutant");

if (mode === "mutant") {
  // biome-ignore lint/suspicious/noExplicitAny: globalThis requires any to access instrumented-source properties
  const g = globalThis as any;
  if (!g.__stryker__) g.__stryker__ = {};
  const realNs: Record<string, unknown> = g.__stryker__;
  const proxy = new Proxy(realNs, {
    get(target, prop) {
      if (prop === "activeMutant") return activeMutant;
      const val = (target as Record<string | symbol, unknown>)[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
    set(target, prop, val) {
      if (prop === "activeMutant") return true; // keep inject()'s value
      (target as Record<string | symbol, unknown>)[prop] = val;
      return true;
    },
  });
  g.__stryker__ = proxy;
}
