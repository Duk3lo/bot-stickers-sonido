/** Wire formats supported for the sound sticker (see README, "Formato del protocolo"). */
export const WIRE_FORMATS = ["sticker-field-26", "audio-sticker-134"] as const;
export type WireFormat = (typeof WIRE_FORMATS)[number];

export interface Config {
  readonly allowedNumbers: ReadonlySet<string>;
  readonly maxSoundSeconds: number;
  readonly authDir: string;
  readonly pairingPhone: string | undefined;
  readonly wireFormat: WireFormat;
}

/** Thrown when the environment is invalid. The message is shown to the user in Spanish. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const PHONE_PATTERN = /^\d{6,15}$/;
const MAX_SOUND_SECONDS_LIMIT = 10;
const DEFAULT_MAX_SOUND_SECONDS = 10;
const DEFAULT_AUTH_DIR = "./auth";
const DEFAULT_WIRE_FORMAT: WireFormat = "sticker-field-26";

/** Keeps only the digits of a phone number, so "+34 600-111-222" becomes "34600111222". */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s+\-()]/g, "");
}

function parseAllowedNumbers(raw: string | undefined, problems: string[]): Set<string> {
  const numbers = new Set<string>();
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    problems.push(
      "Falta ALLOWED_NUMBERS. Indica al menos un número, separados por comas (ej: 34600111222).",
    );
    return numbers;
  }

  for (const entry of entries) {
    const phone = normalizePhone(entry);
    if (!PHONE_PATTERN.test(phone)) {
      problems.push(
        `ALLOWED_NUMBERS contiene un número no válido: "${entry}". Usa solo dígitos con código de país.`,
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
    problems.push(
      `MAX_SOUND_SECONDS debe ser un entero entre 1 y ${MAX_SOUND_SECONDS_LIMIT} (valor recibido: "${raw}").`,
    );
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
    problems.push(
      `SOUND_WIRE_FORMAT debe ser uno de: ${WIRE_FORMATS.join(", ")} (valor recibido: "${raw}").`,
    );
    return DEFAULT_WIRE_FORMAT;
  }
  return found;
}

/**
 * Reads and validates the configuration from environment variables.
 * Collects every problem and throws a single ConfigError listing them all.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];

  const allowedNumbers = parseAllowedNumbers(env["ALLOWED_NUMBERS"], problems);
  const maxSoundSeconds = parseMaxSoundSeconds(env["MAX_SOUND_SECONDS"], problems);
  const wireFormat = parseWireFormat(env["SOUND_WIRE_FORMAT"], problems);

  const authDir = env["AUTH_DIR"]?.trim() || DEFAULT_AUTH_DIR;

  const rawPairing = env["PAIRING_PHONE"]?.trim();
  let pairingPhone: string | undefined;
  if (rawPairing !== undefined && rawPairing !== "") {
    const phone = normalizePhone(rawPairing);
    if (PHONE_PATTERN.test(phone)) {
      pairingPhone = phone;
    } else {
      problems.push(`PAIRING_PHONE no es válido: "${rawPairing}". Usa solo dígitos con código de país.`);
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
  };
}
