import { HOST_POLICY } from "./hostPolicy.js";

const HOST_RE = /https?:\/\/([^/\s"'<>]+)/g;
const PLACEHOLDER_RE = /^\{[^}]+\}\./;

const ALL_KNOWN = Object.values(HOST_POLICY).flat();

function normalise(host: string): string {
  return host.replace(PLACEHOLDER_RE, "*.");
}

export function scanHosts(sources: string[]): string[] {
  const found = new Set<string>();
  for (const src of sources) {
    for (const [, host] of src.matchAll(HOST_RE)) {
      found.add(normalise(host!));
    }
  }
  return [...found].sort();
}

export function unknownHosts(found: string[]): string[] {
  return found.filter((h) => !(ALL_KNOWN as readonly string[]).includes(h));
}
