import { execFile } from "node:child_process";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { promisify } from "node:util";
import qrcode from "qrcode-terminal";
import type { Logger } from "./logger.js";
import { isPrivateIPv4 } from "./red-local.js";

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

const VIRTUAL_INTERFACE = /^(docker|veth|br-)/;
const PREFERRED_INTERFACE = /^(wlan|wl|en|eth)/;

/** Private IPv4 addresses of this machine, physical Wi-Fi/Ethernet first; virtual and internal ones are skipped. */
export function chooseLanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  const found: { address: string; preferred: boolean }[] = [];
  for (const [name, entries] of Object.entries(interfaces).sort(([a], [b]) => a.localeCompare(b))) {
    if (VIRTUAL_INTERFACE.test(name)) {
      continue;
    }
    for (const entry of entries ?? []) {
      // Older Node versions report the family as the number 4.
      const isIPv4 = entry.family === "IPv4" || (entry.family as unknown) === 4;
      if (isIPv4 && !entry.internal && isPrivateIPv4(entry.address)) {
        found.push({ address: entry.address, preferred: PREFERRED_INTERFACE.test(name) });
      }
    }
  }
  return [...found.filter((entry) => entry.preferred), ...found.filter((entry) => !entry.preferred)].map(
    (entry) => entry.address,
  );
}

/** Addresses to offer, best first: the LAN ones, then Tailscale, and loopback only when nothing else exists. */
export function chooseAddresses(lanAddresses: readonly string[], port: number, tailscaleAddress: string | undefined): string[] {
  const addresses = lanAddresses.map((address) => `http://${address}:${port}`);
  if (tailscaleAddress !== undefined) {
    addresses.push(tailscaleAddress);
  }
  return addresses.length > 0 ? addresses : [`http://127.0.0.1:${port}`];
}

/** `sudo ufw` command limited to the /24 of the given LAN address. */
export function firewallCommand(lanAddress: string, port: number): string {
  const [a, b, c] = lanAddress.split(".");
  return `sudo ufw allow from ${a}.${b}.${c}.0/24 to any port ${port} proto tcp`;
}

export interface ConnectionLinkDeps {
  readonly token: string;
  readonly port: number;
  readonly listenOnNetwork: boolean;
  readonly log: Logger;
  readonly findTailscale?: () => Promise<string | undefined>;
  readonly interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  readonly write?: (text: string) => void;
}

/** Writes straight to stdout, never to the log, so it must only run in an interactive terminal. */
export async function printConnectionLink(deps: ConnectionLinkDeps): Promise<void> {
  const tailscaleAddress = await (deps.findTailscale ?? findTailscaleAddress)();
  const lanAddresses = deps.listenOnNetwork ? chooseLanAddresses((deps.interfaces ?? networkInterfaces)()) : [];
  const [main = "", ...others] = chooseAddresses(lanAddresses, deps.port, tailscaleAddress);
  const link = buildConnectionLink(main, deps.token);
  const write = deps.write ?? ((text: string) => void process.stdout.write(text));
  deps.log.info({ lanAddresses: lanAddresses.length }, "Enlace de conexión para la app listo en la terminal.");
  const drawing = await new Promise<string>((resolve) => {
    qrcode.generate(link, { small: true }, resolve);
  });
  const lines = ["", "Enlace de conexión para la app (contiene el token: no lo compartas):", link, drawing];
  if (others.length > 0) {
    lines.push("Otras direcciones posibles (mismo enlace con otra dirección):");
    lines.push(...others.map((address) => buildConnectionLink(address, deps.token)));
  }
  if (lanAddresses.length > 0) {
    lines.push(
      "El celular debe estar en la misma Wi-Fi. Si no conecta, quizá haga falta abrir el puerto en el cortafuegos:",
      `  ${firewallCommand(lanAddresses[0] as string, deps.port)}`,
    );
  }
  if (tailscaleAddress !== undefined) {
    lines.push(`Para la dirección de Tailscale hace falta tener activo: tailscale serve --bg ${deps.port}`);
  }
  write(`${lines.join("\n")}\n`);
}
