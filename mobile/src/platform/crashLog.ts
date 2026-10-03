import { File, Paths } from "expo-file-system";

export async function logCrash(error: unknown): Promise<void> {
  try {
    const msg = error instanceof Error ? error.message : String(error);
    const line = `${new Date().toISOString()}\t${msg}\n`;
    new File(Paths.document, "crash.log").write(line, { append: true });
  } catch {
    // swallow — throwing here would recurse back into the global error handler
  }
}
