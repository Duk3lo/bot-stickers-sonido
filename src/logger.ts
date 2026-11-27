import pino from "pino";

const HIDDEN = "[oculto]";
const JID_OR_LONG_NUMBER =
  /[\w.:-]*@(?:s\.whatsapp\.net|c\.us|g\.us|lid|hosted\.lid|hosted|broadcast|newsletter)\b|\d{6,}/g;
/** Names inside the XML Baileys prints: `notify='Name'`. Quotes in a name are not escaped. */
const NAME_ATTRIBUTE = /\b(\w*notify|verified_name)=(['"])[\s\S]*?\2(?=\s|\/?>|$)/g;
/** Fields whose value is private even when it has no digits. The `node` ones are raw Baileys XML. */
const PRIVATE_KEYS = new Set([
  "qr", "pairingCode", "pushName", "notify", "verifiedBizName", "node", "fullErrorNode", "reasonNode",
]);

/** Removes JIDs, phone-like digit runs and contact names from a text. */
export function redact(text: string): string {
  return text.replace(NAME_ATTRIBUTE, `$1=${HIDDEN}`).replace(JID_OR_LONG_NUMBER, HIDDEN);
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  // A serialized Buffer: its bytes may spell out numbers or keys.
  if ("type" in value && value.type === "Buffer") {
    return "[binario]";
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      redact(key),
      PRIVATE_KEYS.has(key) ? HIDDEN : redactValue(inner),
    ]),
  );
}

/**
 * Every line is sanitized after serialization, so it also covers child loggers and the errors
 * that Baileys logs on its own.
 */
export function createLogger(level: string, destination?: pino.DestinationStream) {
  const options: pino.LoggerOptions = {
    name: "bot-stickers-sonido",
    level,
    hooks: { streamWrite: (line) => `${JSON.stringify(redactValue(JSON.parse(line)))}\n` },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export const logger = createLogger(process.env["LOG_LEVEL"] ?? "info");

export type Logger = typeof logger;

/**
 * Baileys' dependency libsignal writes straight to the console, dumping session keys and
 * addresses. Only the leading text survives, sanitized and at debug level.
 */
export function captureConsole(log: Logger): void {
  const capture = (first: unknown): void => {
    log.debug({ detail: typeof first === "string" ? first : undefined }, "Aviso de una dependencia.");
  };
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    console[method] = capture;
  }
}
