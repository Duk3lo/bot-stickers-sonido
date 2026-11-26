import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

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
