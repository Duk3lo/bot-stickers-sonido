import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";

/** File names written by Baileys' useMultiFileAuthState: creds.json and `<key type>-<id>.json`. */
const BAILEYS_FILE =
  /^(creds|(pre-key|session|sender-key|sender-key-memory|app-state-sync-key|app-state-sync-version|lid-mapping|device-list|tctoken|identity-key)-.+)\.json$/;

export class UnreadableSessionError extends Error {
  constructor(cause?: unknown) {
    super("creds.json existe en AUTH_DIR pero no se puede leer (permisos o archivo dañado).", { cause });
    this.name = "UnreadableSessionError";
  }
}

/**
 * useMultiFileAuthState silently replaces a creds.json it cannot read with blank credentials, which
 * would later be saved over it. This checks the file first.
 */
export async function loadAuthState(authDir: string): ReturnType<typeof useMultiFileAuthState> {
  await assertReadableCreds(join(authDir, "creds.json"));
  return useMultiFileAuthState(authDir);
}

async function assertReadableCreds(path: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    // A parse error quotes the file, which holds secret keys: it must not travel as the cause.
    throw new UnreadableSessionError(error instanceof SyntaxError ? undefined : error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UnreadableSessionError();
  }
}

/**
 * Deletes the WhatsApp session. Only Baileys' own files are removed, never the folder or anything
 * else, because AUTH_DIR may point somewhere it should not.
 */
export async function clearAuthFiles(authDir: string): Promise<void> {
  const entries = await readdir(authDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && BAILEYS_FILE.test(entry.name))
      .map((entry) => unlink(join(authDir, entry.name))),
  );
}
