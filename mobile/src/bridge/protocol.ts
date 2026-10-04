import { z } from "zod";

export const ORIGIN = "https://crossfog.madera.codes/";

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const shortName = z.string().min(1).max(255);
const savedAt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
const base64Data = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

const webToNativeSchema = z.union([
  z.object({ v: z.literal(1), type: z.literal("ready") }),
  z.object({ v: z.literal(1), type: z.literal("pickBackup") }),
  z.object({ v: z.literal(1), type: z.literal("needBytes"), fingerprint }),
  z.object({
    v: z.literal(1),
    type: z.literal("loaded"),
    fingerprint,
    ok: z.literal(true),
    tiles: z.number().int().min(1),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("loaded"),
    fingerprint,
    ok: z.literal(false),
    reason: z.enum(["unzip", "noTiles", "memory", "checksum", "unknown"]),
  }),
  z.object({ v: z.literal(1), type: z.literal("clearSavedFog") }),
  z.object({ v: z.literal(1), type: z.literal("retryRestore") }),
  z.object({
    v: z.literal(1),
    type: z.literal("export"),
    filename: shortName,
    mime: z.string().min(1).max(100),
    text: z.string(),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("openExternal"),
    url: z.string().regex(/^https?:\/\//),
  }),
  z.object({ v: z.literal(1), type: z.literal("openAbout") }),
  z.object({ v: z.literal(1), type: z.literal("back:result"), handled: z.boolean() }),
]);

const nativeToWebSchema = z.union([
  z.object({
    v: z.literal(1),
    type: z.literal("restore"),
    fingerprint,
    name: shortName,
    savedAt,
    size: z.number().int().min(0),
    role: z.enum(["current", "pending"]),
  }),
  z
    .object({
      v: z.literal(1),
      type: z.literal("chunk"),
      fingerprint,
      index: z.number().int().min(0),
      total: z.number().int().min(1),
      data: base64Data,
    })
    .refine((c) => c.index < c.total, "index must be less than total"),
  z.object({ v: z.literal(1), type: z.literal("none") }),
  z.object({ v: z.literal(1), type: z.literal("restoreSuspended"), savedAt }),
  z.object({
    v: z.literal(1),
    type: z.literal("notice"),
    text: z.string().min(1).max(500),
  }),
  z.object({ v: z.literal(1), type: z.literal("back") }),
]);

export type WebToNative = z.infer<typeof webToNativeSchema>;
export type NativeToWeb = z.infer<typeof nativeToWebSchema>;
export type ChunkMessage = Extract<NativeToWeb, { type: "chunk" }>;

export function encode(msg: WebToNative | NativeToWeb): string {
  return JSON.stringify(msg);
}

export function parseWebToNative(raw: string): WebToNative | null {
  try {
    const result = webToNativeSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseNativeToWeb(raw: string): NativeToWeb | null {
  try {
    const result = nativeToWebSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// Android WebView reports the baseUrl without its trailing slash in onMessage events.
export function isTrustedSource(url: string): boolean {
  return (
    url === ORIGIN ||
    url === ORIGIN.slice(0, -1) ||
    (url.startsWith(ORIGIN) && (url[ORIGIN.length] === "#" || url[ORIGIN.length] === "?"))
  );
}
