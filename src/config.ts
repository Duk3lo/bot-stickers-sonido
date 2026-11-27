import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Wire formats supported for the sound sticker (see README, "Formato del protocolo"). */
export const WIRE_FORMATS = ["sticker-field-26", "audio-sticker-134"] as const;
export type WireFormat = (typeof WIRE_FORMATS)[number];

export interface Config {
  readonly allowedNumbers: ReadonlySet<string>;
  readonly maxSoundSeconds: number;
  readonly authDir: string;
  readonly pairingPhone: string | undefined;
  readonly wireFormat: WireFormat;
  /** Path to the conversor-stickers binary; when absent the WebP is made with ffmpeg. */
  readonly conversorBin: string | undefined;
  readonly controlPort: number;
  /** Listen on the local network too (only loopback, private and Tailscale origins are served). */
  readonly listenOnNetwork: boolean;
  /** Only videos sent to the linked account's chat with itself are processed, one per activation. */
  readonly ownChatMode: boolean;
}

/** Thrown when the environment is invalid. The message is shown to the user in Spanish. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const PHONE_PATTERN = /^\d{6,15}$/;
const MAX_SOUND_SECONDS_LIMIT = 60;
const DEFAULT_MAX_SOUND_SECONDS = 10;
const DEFAULT_AUTH_DIR = "./auth";
const DEFAULT_WIRE_FORMAT: WireFormat = "sticker-field-26";
const DEFAULT_CONTROL_PORT = 8787;

/** Keeps only the digits of a phone number, so "+34 600-111-222" becomes "34600111222". */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s+\-()]/g, "");
}

function parseAllowedNumbers(raw: string | undefined, required: boolean, problems: string[]): Set<string> {
  const numbers = new Set<string>();
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0 && required) {
    problems.push(
      "Falta ALLOWED_NUMBERS. Indica al menos un número, separados por comas (ej: 34600111222).",
    );
  }

  for (const [index, entry] of entries.entries()) {
    const phone = normalizePhone(entry);
    if (!PHONE_PATTERN.test(phone)) {
      problems.push(
        `ALLOWED_NUMBERS: la entrada ${index + 1} no es un número válido. Usa solo dígitos con código de país.`,
      );
    } else {
      numbers.add(phone);
    }
  }
  return numbers;
}

function parseMaxSoundSeconds(raw: string | undefined, problems: string[]): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_SOUND_SECONDS;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_SOUND_SECONDS_LIMIT) {
    problems.push(`MAX_SOUND_SECONDS debe ser un entero entre 1 y ${MAX_SOUND_SECONDS_LIMIT}.`);
    return DEFAULT_MAX_SOUND_SECONDS;
  }
  return value;
}

function parseWireFormat(raw: string | undefined, problems: string[]): WireFormat {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_WIRE_FORMAT;
  }
  const found = WIRE_FORMATS.find((format) => format === raw.trim());
  if (found === undefined) {
    problems.push(`SOUND_WIRE_FORMAT debe ser uno de: ${WIRE_FORMATS.join(", ")}.`);
    return DEFAULT_WIRE_FORMAT;
  }
  return found;
}

function parseConversorBin(raw: string | undefined, problems: string[]): string | undefined {
  const path = raw?.trim();
  if (path === undefined || path === "") {
    return undefined;
  }
  if (!isAbsolute(path) || !existsSync(path)) {
    problems.push("CONVERSOR_BIN debe ser una ruta absoluta a un archivo existente.");
    return undefined;
  }
  return path;
}

function parseControlPort(raw: string | undefined, problems: string[]): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_CONTROL_PORT;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    problems.push("CONTROL_PORT debe ser un puerto entre 1 y 65535.");
    return DEFAULT_CONTROL_PORT;
  }
  return value;
}

/** A typo must not silently leave the bot answering other chats, so unknown values are rejected. */
function parseOwnChatMode(raw: string | undefined, problems: string[]): boolean {
  const value = raw?.trim() ?? "";
  if (value !== "" && value !== "si" && value !== "no") {
    problems.push("MODO_CHAT_PROPIO debe ser «si» o «no».");
  }
  return value === "si";
}

/** Defaults to «si»; a typo must not silently expose or hide the API, so unknown values are rejected. */
function parseListenOnNetwork(raw: string | undefined, problems: string[]): boolean {
  const value = raw?.trim() ?? "";
  if (value !== "" && value !== "si" && value !== "no") {
    problems.push("ESCUCHAR_EN_RED debe ser «si» o «no».");
  }
  return value !== "no";
}

/**
 * Reads and validates the configuration from environment variables.
 * Collects every problem and throws a single ConfigError listing them all.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];

  if (env["ACEPTO_AVISO"]?.trim() !== "si") {
    problems.push(
      "Falta ACEPTO_AVISO=si en .env. Lee AVISO.md y, si lo aceptas, añade esa línea para poder arrancar el bot.",
    );
  }

  const ownChatMode = parseOwnChatMode(env["MODO_CHAT_PROPIO"], problems);
  const allowedNumbers = parseAllowedNumbers(env["ALLOWED_NUMBERS"], !ownChatMode, problems);
  const maxSoundSeconds = parseMaxSoundSeconds(env["MAX_SOUND_SECONDS"], problems);
  const wireFormat = parseWireFormat(env["SOUND_WIRE_FORMAT"], problems);
  const conversorBin = parseConversorBin(env["CONVERSOR_BIN"], problems);

  const controlPort = parseControlPort(env["CONTROL_PORT"], problems);

  const authDir = env["AUTH_DIR"]?.trim() || DEFAULT_AUTH_DIR;
  const listenOnNetwork = parseListenOnNetwork(env["ESCUCHAR_EN_RED"], problems);

  const rawPairing = env["PAIRING_PHONE"]?.trim();
  let pairingPhone: string | undefined;
  if (rawPairing !== undefined && rawPairing !== "") {
    const phone = normalizePhone(rawPairing);
    if (PHONE_PATTERN.test(phone)) {
      pairingPhone = phone;
    } else {
      problems.push("PAIRING_PHONE no es válido. Usa solo dígitos con código de país.");
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Configuración no válida:\n- ${problems.join("\n- ")}`);
  }

  return {
    allowedNumbers,
    maxSoundSeconds,
    authDir,
    pairingPhone,
    wireFormat,
    conversorBin,
    controlPort,
    listenOnNetwork,
    ownChatMode,
  };
}
