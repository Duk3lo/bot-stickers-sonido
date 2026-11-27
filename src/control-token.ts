import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class ControlTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlTokenError";
  }
}

/** Returns the API token stored in `path`, creating it (mode 0600) on the first start. */
export async function loadOrCreateControlToken(path: string): Promise<string> {
  try {
    await writeFile(path, `${randomBytes(TOKEN_BYTES).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  await chmod(path, 0o600);
  const token = (await readFile(path, "utf8")).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new ControlTokenError(
      "El archivo de CONTROL_TOKEN_FILE no contiene un token válido. Bórralo para que se genere uno nuevo.",
    );
  }
  return token;
}

const LEGACY_TOKEN_FILE = "./control-token";

/** `$XDG_CONFIG_HOME/bot-stickers-sonido`, or `~/.config/bot-stickers-sonido`. */
export function defaultControlDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const configHome = env["XDG_CONFIG_HOME"]?.trim();
  return join(configHome ? configHome : join(home, ".config"), "bot-stickers-sonido");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Moves the old token so it does not change; falls back to copy and delete across filesystems. */
async function moveToken(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    await copyFile(from, to);
    await chmod(to, 0o600);
    await unlink(from);
  }
}

export interface ControlTokenSetup {
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
  readonly home?: string;
  readonly legacyPath?: string;
}

/**
 * Loads the token from CONTROL_TOKEN_FILE or the default config folder (dir 0700), adopting an old
 * `./control-token` there, and writes `conexion.json` (0600) beside it so the desktop app finds the port.
 */
export async function setUpControlToken({
  env,
  port,
  home,
  legacyPath = LEGACY_TOKEN_FILE,
}: ControlTokenSetup): Promise<string> {
  const explicitPath = env["CONTROL_TOKEN_FILE"]?.trim();
  const dir = explicitPath ? dirname(explicitPath) : defaultControlDir(env, home);
  const tokenPath = explicitPath ? explicitPath : join(dir, "control-token");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!explicitPath) {
    await chmod(dir, 0o700);
    if (!(await exists(tokenPath)) && (await exists(legacyPath))) {
      await moveToken(legacyPath, tokenPath);
    }
  }
  const token = await loadOrCreateControlToken(tokenPath);
  const connectionPath = join(dir, "conexion.json");
  await writeFile(connectionPath, `${JSON.stringify({ version: 1, puerto: port })}\n`, { mode: 0o600 });
  await chmod(connectionPath, 0o600);
  return token;
}
