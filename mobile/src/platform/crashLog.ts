import { File, Paths } from "expo-file-system";

// A decimal with three or more places is treated as a position (about 100 m at three), so it never reaches a log.
const POSITION_LIKE = /-?\d*\.\d{3,}/g;

// Native file errors name the cache path, which holds an export id.
const PATH_LIKE = /(?:file:\/\/)?\/(?:data|storage|sdcard|mnt)\/[^\s,;:)"']*/g;

export function scrubCoordinates(message: string): string {
  return message.replace(PATH_LIKE, "[path]").replace(POSITION_LIKE, "[n]");
}

export async function logCrash(error: unknown): Promise<void> {
  try {
    const msg = scrubCoordinates(error instanceof Error ? error.message : String(error));
    // The timestamp has three decimals too, so it is added after the message is scrubbed.
    const line = `${new Date().toISOString()}\t${msg}\n`;
    await new File(Paths.document, "crash.log").write(line, { append: true });
  } catch {
    // swallow — throwing here would recurse back into the global error handler
  }
}
