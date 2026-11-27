import { execFile } from "node:child_process";
import { promisify } from "node:util";
import qrcode from "qrcode-terminal";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);
const TAILSCALE_TIMEOUT_MS = 2000;

/** Fixed format: the app parses it. The token goes in the fragment so it never travels to a server. */
export function buildConnectionLink(address: string, token: string): string {
  return `conversorstickers://bot#u=${encodeURIComponent(address)}&t=${token}`;
}

/** `https://<DNSName>` from the output of `tailscale status --json`, or undefined if it has none. */
export function parseTailscaleAddress(statusJson: string): string | undefined {
  let status: unknown;
  try {
    status = JSON.parse(statusJson);
  } catch {
    return undefined;
  }
  const self = (status as { Self?: { DNSName?: unknown } } | null)?.Self;
  if (typeof self?.DNSName !== "string") {
    return undefined;
  }
  const host = self.DNSName.replace(/\.$/, "");
  return host === "" ? undefined : `https://${host}`;
}

/** Tailscale being missing, slow or failing is not an error: the local address is used instead. */
export async function findTailscaleAddress(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: TAILSCALE_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return parseTailscaleAddress(stdout);
  } catch {
    return undefined;
  }
}

export interface ConnectionLinkDeps {
  readonly token: string;
  readonly port: number;
  readonly log: Logger;
  readonly findTailscale?: () => Promise<string | undefined>;
  readonly write?: (text: string) => void;
}

/** Writes straight to stdout, never to the log, so it must only run in an interactive terminal. */
export async function printConnectionLink(deps: ConnectionLinkDeps): Promise<void> {
  const tailscaleAddress = await (deps.findTailscale ?? findTailscaleAddress)();
  const address = tailscaleAddress ?? `http://127.0.0.1:${deps.port}`;
  const link = buildConnectionLink(address, deps.token);
  const write = deps.write ?? ((text: string) => void process.stdout.write(text));
  deps.log.info({ viaTailscale: tailscaleAddress !== undefined }, "Enlace de conexión para la app listo en la terminal.");
  const drawing = await new Promise<string>((resolve) => {
    qrcode.generate(link, { small: true }, resolve);
  });
  const lines = ["", "Enlace de conexión para la app (contiene el token: no lo compartas):", link, drawing];
  if (tailscaleAddress !== undefined) {
    lines.push(`Hace falta tener activo: tailscale serve --bg ${deps.port}`, "");
  }
  write(`${lines.join("\n")}\n`);
}
