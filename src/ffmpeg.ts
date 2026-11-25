import { execFile } from "node:child_process";

export const STICKER_SIZE = 512;
export const STICKER_MAX_BYTES = 500_000;
export const STICKER_MAX_SECONDS = 10;
export const AUDIO_SAMPLE_RATE = 48_000;

/** Error raised when ffmpeg/ffprobe fail or time out. The message is in Spanish. */
export class FfmpegError extends Error {
  /** Exit code of the process, when it ended with one. */
  readonly exitCode: number | undefined;

  constructor(message: string, exitCode?: number) {
    super(message);
    this.name = "FfmpegError";
    this.exitCode = exitCode;
  }
}

export interface VideoStickerOptions {
  readonly input: string;
  readonly output: string;
  readonly seconds: number;
  readonly fps: number;
  /** libwebp quality, 0 (worst) to 100 (best). */
  readonly quality: number;
  /** Start of the clip in the input, in seconds. */
  readonly start?: number;
  /** End of the clip in the input, in seconds. */
  readonly end?: number;
}

export interface AudioOptions {
  readonly input: string;
  readonly output: string;
  readonly seconds: number;
  readonly start?: number;
  readonly end?: number;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} debe ser un número positivo (valor: ${value}).`);
  }
}

/** Input-side arguments that select the clip; empty when no range was asked for. */
function rangeArgs(start: number | undefined, end: number | undefined): string[] {
  if (start !== undefined && (!Number.isFinite(start) || start < 0)) {
    throw new RangeError(`start debe ser un número mayor o igual que 0 (valor: ${start}).`);
  }
  if (end !== undefined) {
    assertPositive("end", end);
    if (end <= (start ?? 0)) {
      throw new RangeError(`end debe ser mayor que start (start: ${start ?? 0}, end: ${end}).`);
    }
  }
  return [
    ...(start === undefined ? [] : ["-ss", String(start)]),
    ...(end === undefined ? [] : ["-to", String(end)]),
  ];
}

/** Arguments for an animated 512x512 WebP, transparent padding, no audio, at most 10 s. */
export function buildVideoStickerArgs(options: VideoStickerOptions): string[] {
  assertPositive("seconds", options.seconds);
  assertPositive("fps", options.fps);
  if (!Number.isInteger(options.quality) || options.quality < 0 || options.quality > 100) {
    throw new RangeError(`quality debe ser un entero entre 0 y 100 (valor: ${options.quality}).`);
  }
  const seconds = Math.min(options.seconds, STICKER_MAX_SECONDS);
  const filter = [
    `fps=${options.fps}`,
    `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos`,
    "format=rgba",
    `pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
  ].join(",");

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...rangeArgs(options.start, options.end),
    "-i",
    options.input,
    "-t",
    String(seconds),
    "-map_metadata",
    "-1",
    "-an",
    "-vf",
    filter,
    "-c:v",
    "libwebp",
    "-loop",
    "0",
    "-preset",
    "picture",
    "-compression_level",
    "6",
    "-q:v",
    String(options.quality),
    "-f",
    "webp",
    options.output,
  ];
}

/** Exit code of conversor-stickers when the clip does not fit the preset's weight or duration. */
export const CONVERSOR_EXIT_TOO_LARGE = 5;

export interface ConversorOptions {
  readonly input: string;
  readonly output: string;
  /** Start of the clip in the input, in seconds. */
  readonly start: number;
  /** Length of the clip, in seconds (capped to the 10 s of the sticker). */
  readonly seconds: number;
}

/** Arguments for the conversor-stickers CLI with the WhatsApp sticker preset. */
export function buildConversorArgs(options: ConversorOptions): string[] {
  assertPositive("seconds", options.seconds);
  if (!Number.isFinite(options.start) || options.start < 0) {
    throw new RangeError(`start debe ser un número mayor o igual que 0 (valor: ${options.start}).`);
  }
  return [
    options.input,
    "--preset",
    "whatsapp-sticker",
    "-o",
    options.output,
    "--start",
    String(options.start),
    "--max-seconds",
    String(Math.min(options.seconds, STICKER_MAX_SECONDS)),
  ];
}

/** Arguments for mono OGG Opus at 48 kHz, no video, at most `seconds`. */
export function buildAudioArgs(options: AudioOptions): string[] {
  assertPositive("seconds", options.seconds);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...rangeArgs(options.start, options.end),
    "-i",
    options.input,
    "-t",
    String(options.seconds),
    "-map_metadata",
    "-1",
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(AUDIO_SAMPLE_RATE),
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    "-f",
    "ogg",
    options.output,
  ];
}

/** Arguments that print only the container duration in seconds. */
export function buildProbeArgs(input: string): string[] {
  return ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input];
}

/** Arguments that print one line per audio stream; empty output means the file has no audio. */
export function buildAudioProbeArgs(input: string): string[] {
  return ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", input];
}

export interface RunOptions {
  readonly timeoutMs: number;
  readonly binary?: string;
}

/**
 * Runs a binary with an argument array (never through a shell).
 * The process is killed when it exceeds timeoutMs.
 */
export function runBinary(args: readonly string[], options: RunOptions): Promise<string> {
  const binary = options.binary ?? "ffmpeg";
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const timedOut = error.killed === true && error.signal === "SIGKILL";
          reject(
            new FfmpegError(
              timedOut
                ? `${binary} tardó demasiado y se canceló.`
                : `${binary} falló al procesar el archivo.`,
              typeof error.code === "number" ? error.code : undefined,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Returns the duration of the input in seconds, or throws FfmpegError when it cannot be read. */
export async function probeDurationSeconds(input: string, timeoutMs: number): Promise<number> {
  const stdout = await runBinary(buildProbeArgs(input), { timeoutMs, binary: "ffprobe" });
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new FfmpegError("No pude leer la duración del video.");
  }
  return duration;
}

/** Returns whether the input has at least one audio stream. */
export async function hasAudioStream(input: string, timeoutMs: number): Promise<boolean> {
  const stdout = await runBinary(buildAudioProbeArgs(input), { timeoutMs, binary: "ffprobe" });
  return stdout.trim().length > 0;
}
