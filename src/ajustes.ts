/**
 * The square cut out of the video to fill the sticker: `zoom` shrinks its side from the video's short
 * side, and `x`/`y` are its centre as fractions of the width and height.
 */
export interface Crop {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

/** Optional trimming and audio settings sent by the user in the video caption ("inicio=2 fin=7 sonido=5"). */
export interface Settings {
  /** Start of the clip, in seconds. */
  readonly start?: number;
  /** End of the clip, in seconds. */
  readonly end?: number;
  /** Seconds of audio to keep. */
  readonly sound?: number;
  /** Absent keeps the whole video, with transparent borders. */
  readonly crop?: Crop;
}

export type SettingsResult =
  | { readonly ok: true; readonly settings: Settings }
  | { readonly ok: false; readonly errors: readonly string[] };

const SECONDS_PATTERN = /^\d+(?:[.,]\d+)?$/;
const INTEGER_PATTERN = /^\d+$/;
const KNOWN_KEYS = ["inicio", "fin", "sonido", "encuadre", "zoom", "x", "y"];
const MAX_ZOOM = 4;

function parseCrop(values: ReadonlyMap<string, string>, errors: string[]): Crop | undefined {
  const mode = values.get("encuadre")?.toLowerCase();
  if (mode !== undefined && mode !== "entero" && mode !== "recortar") {
    errors.push("«encuadre» debe ser entero o recortar.");
    return undefined;
  }
  if (mode !== "recortar") {
    if (["zoom", "x", "y"].some((key) => values.has(key))) {
      errors.push("«zoom», «x» e «y» solo se usan con encuadre=recortar.");
    }
    return undefined;
  }
  const between = (key: string, fallback: number, min: number, max: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw.replace(",", "."));
    if (!SECONDS_PATTERN.test(raw) || value < min || value > max) {
      errors.push(`«${key}» debe ser un número entre ${min} y ${max}.`);
      return fallback;
    }
    return value;
  };
  return { zoom: between("zoom", 1, 1, MAX_ZOOM), x: between("x", 0.5, 0, 1), y: between("y", 0.5, 0, 1) };
}

export function isHelpRequest(text: string | null | undefined): boolean {
  return text?.trim().toLowerCase() === "ayuda";
}

/** Parses the caption. Error messages are in Spanish because the bot sends them to the user. */
export function parseSettings(caption: string | null | undefined, maxSoundSeconds: number): SettingsResult {
  const errors: string[] = [];
  const values = new Map<string, string>();

  for (const token of (caption ?? "").split(/\s+/).filter((part) => part.length > 0)) {
    const separator = token.indexOf("=");
    const key = separator === -1 ? "" : token.slice(0, separator).toLowerCase();
    if (!KNOWN_KEYS.includes(key)) {
      errors.push(`No entiendo «${token}». Los ajustes válidos son inicio, fin, sonido, encuadre, zoom, x e y.`);
    } else if (values.has(key)) {
      errors.push(`El ajuste «${key}» está repetido.`);
    } else {
      values.set(key, token.slice(separator + 1));
    }
  }

  const seconds = (key: string): number | undefined => {
    const raw = values.get(key);
    if (raw === undefined) {
      return undefined;
    }
    if (!SECONDS_PATTERN.test(raw)) {
      errors.push(`«${key}» debe ser un número de segundos, por ejemplo ${key}=2 o ${key}=2,5.`);
      return undefined;
    }
    return Number(raw.replace(",", "."));
  };

  const start = seconds("inicio");
  const end = seconds("fin");
  let sound: number | undefined;

  const rawSound = values.get("sonido");
  if (rawSound !== undefined) {
    const parsed = Number(rawSound);
    if (!INTEGER_PATTERN.test(rawSound) || parsed < 1 || parsed > maxSoundSeconds) {
      errors.push(`«sonido» debe ser un número entero de segundos entre 1 y ${maxSoundSeconds}.`);
    } else {
      sound = parsed;
    }
  }

  if (end !== undefined && end <= (start ?? 0)) {
    errors.push("«fin» debe ser mayor que «inicio».");
  }

  const crop = parseCrop(values, errors);

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const settings: Settings = {
    ...(start !== undefined && { start }),
    ...(end !== undefined && { end }),
    ...(sound !== undefined && { sound }),
    ...(crop !== undefined && { crop }),
  };
  return { ok: true, settings };
}
