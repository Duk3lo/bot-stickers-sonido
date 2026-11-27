import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAudioArgs,
  buildConversorArgs,
  CONVERSOR_EXIT_TOO_LARGE,
  buildVideoStickerArgs,
  hasAudioStream,
  probeDurationSeconds,
  runBinary,
  STICKER_MAX_BYTES,
  STICKER_MAX_SECONDS,
  FfmpegError,
} from "./ffmpeg.js";
import type { Crop, Settings } from "./ajustes.js";

const FFPROBE_TIMEOUT_MS = 15_000;
const FFMPEG_TIMEOUT_MS = 90_000;
/** The CLI searches for the best fit by encoding several times, so it needs more room. */
const CONVERSOR_TIMEOUT_MS = 180_000;

/** Quality ladder for the sticker: the first step that fits in 500 KB wins. */
const STICKER_ATTEMPTS = [
  { fps: 15, quality: 60 },
  { fps: 12, quality: 40 },
  { fps: 10, quality: 25 },
  { fps: 8, quality: 10 },
] as const;

export class StickerTooLargeError extends Error {
  constructor() {
    super("No pude reducir el video a un sticker de menos de 500 KB. Prueba con un clip más corto.");
    this.name = "StickerTooLargeError";
  }
}

export interface SoundStickerFiles {
  readonly webp: Buffer;
  /** Absent when the input video has no audio track. */
  readonly ogg: Buffer | undefined;
  readonly videoSeconds: number;
  readonly audioSeconds: number;
  readonly trimmed: boolean;
}

export interface ClipPlan {
  readonly start: number;
  readonly end: number;
  readonly videoSeconds: number;
  readonly audioSeconds: number;
}

/** Works out the clip to cut from a video of `duration` seconds. An `end` past the video is clamped. */
export function planClip(
  duration: number,
  maxSoundSeconds: number,
  settings: Settings,
  imageMaxSeconds: number = STICKER_MAX_SECONDS,
): ClipPlan {
  const start = settings.start ?? 0;
  if (start >= duration) {
    throw new FfmpegError(`El video dura ${duration.toFixed(1)} s y «inicio» queda fuera de él.`);
  }
  const end = Math.min(settings.end ?? duration, duration);
  const clipSeconds = end - start;
  const videoSeconds = Math.min(clipSeconds, imageMaxSeconds);
  return {
    start,
    end,
    videoSeconds,
    // Without an explicit `sonido`, the audio matches the image so both stay in sync.
    audioSeconds:
      settings.sound === undefined
        ? videoSeconds
        : Math.min(clipSeconds, settings.sound, maxSoundSeconds),
  };
}

/**
 * Turns an input video into an animated WebP (<= 10 s, <= 500 KB) and an OGG Opus clip
 * (<= maxSoundSeconds), both cut to the range in `settings`. All intermediate files live in workDir, which the caller removes.
 */
export async function buildSoundSticker(
  inputPath: string,
  workDir: string,
  maxSoundSeconds: number,
  settings: Settings = {},
  conversorBin?: string,
): Promise<SoundStickerFiles> {
  const duration = await probeDurationSeconds(inputPath, FFPROBE_TIMEOUT_MS);
  const firstPlan = planClip(duration, maxSoundSeconds, settings);
  const { start, end } = firstPlan;
  const clipSeconds = end - start;

  const webpPath = join(workDir, "sticker.webp");
  let plan: ClipPlan | undefined;
  for (const imageSeconds of imageSecondsAttempts(firstPlan.videoSeconds)) {
    const attempt = planClip(duration, maxSoundSeconds, settings, imageSeconds);
    try {
      // The conversor binary is not told about the crop, so a cropped sticker is made with ffmpeg.
      if (conversorBin === undefined || settings.crop !== undefined) {
        await makeWebpWithFfmpeg(inputPath, webpPath, start, end, attempt.videoSeconds, settings.crop);
      } else {
        await makeWebpWithConversor(conversorBin, inputPath, webpPath, start, attempt.videoSeconds);
      }
      plan = attempt;
      break;
    } catch (error) {
      if (!(error instanceof StickerTooLargeError)) {
        throw error;
      }
    }
  }
  if (plan === undefined) {
    throw new StickerTooLargeError();
  }
  const { videoSeconds, audioSeconds } = plan;

  let ogg: Buffer | undefined;
  if (await hasAudioStream(inputPath, FFPROBE_TIMEOUT_MS)) {
    const oggPath = join(workDir, "sound.ogg");
    await runBinary(buildAudioArgs({ input: inputPath, output: oggPath, seconds: audioSeconds, start, end }), {
      timeoutMs: FFMPEG_TIMEOUT_MS,
    });
    ogg = await readBuffer(oggPath);
  }
  const webp = await readBuffer(webpPath);
  return {
    webp,
    ogg,
    videoSeconds,
    audioSeconds,
    trimmed: clipSeconds < duration || clipSeconds > maxSoundSeconds || clipSeconds > STICKER_MAX_SECONDS,
  };
}

/**
 * Image lengths to try, longest first. Busy videos do not fit 10 s in 500 KB even at the lowest
 * quality, so the sticker gets shorter before giving up.
 */
export function imageSecondsAttempts(videoSeconds: number): number[] {
  return [videoSeconds, ...[8, 6, 5, 4, 3].filter((seconds) => seconds < videoSeconds)];
}

async function makeWebpWithFfmpeg(
  input: string,
  output: string,
  start: number,
  end: number,
  seconds: number,
  crop: Crop | undefined,
): Promise<void> {
  for (const attempt of STICKER_ATTEMPTS) {
    await runBinary(
      buildVideoStickerArgs({ input, output, seconds, start, end, fps: attempt.fps, quality: attempt.quality, ...(crop && { crop }) }),
      { timeoutMs: FFMPEG_TIMEOUT_MS },
    );
    const { size } = await stat(output);
    if (size <= STICKER_MAX_BYTES) {
      return;
    }
  }
  throw new StickerTooLargeError();
}

async function makeWebpWithConversor(
  binary: string,
  input: string,
  output: string,
  start: number,
  seconds: number,
): Promise<void> {
  try {
    await runBinary(buildConversorArgs({ input, output, start, seconds }), {
      timeoutMs: CONVERSOR_TIMEOUT_MS,
      binary,
    });
  } catch (error) {
    if (error instanceof FfmpegError && error.exitCode === CONVERSOR_EXIT_TOO_LARGE) {
      throw new StickerTooLargeError();
    }
    throw error;
  }
}

function readBuffer(path: string): Promise<Buffer> {
  return readFile(path);
}

export async function writeInput(workDir: string, data: Buffer): Promise<string> {
  const path = join(workDir, "input.bin");
  await writeFile(path, data);
  return path;
}
