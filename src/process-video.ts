import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAudioArgs,
  buildVideoStickerArgs,
  probeDurationSeconds,
  runBinary,
  STICKER_MAX_BYTES,
  STICKER_MAX_SECONDS,
} from "./ffmpeg.js";

const FFPROBE_TIMEOUT_MS = 15_000;
const FFMPEG_TIMEOUT_MS = 90_000;

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
  readonly ogg: Buffer;
  readonly videoSeconds: number;
  readonly audioSeconds: number;
  readonly trimmed: boolean;
}

/**
 * Turns an input video into an animated WebP (<= 8 s, <= 500 KB) and an OGG Opus clip
 * (<= maxSoundSeconds). All intermediate files live in workDir, which the caller removes.
 */
export async function buildSoundSticker(
  inputPath: string,
  workDir: string,
  maxSoundSeconds: number,
): Promise<SoundStickerFiles> {
  const duration = await probeDurationSeconds(inputPath, FFPROBE_TIMEOUT_MS);
  const videoSeconds = Math.min(duration, STICKER_MAX_SECONDS);
  const audioSeconds = Math.min(duration, maxSoundSeconds);

  const webpPath = join(workDir, "sticker.webp");
  let fits = false;
  for (const attempt of STICKER_ATTEMPTS) {
    await runBinary(
      buildVideoStickerArgs({
        input: inputPath,
        output: webpPath,
        seconds: videoSeconds,
        fps: attempt.fps,
        quality: attempt.quality,
      }),
      { timeoutMs: FFMPEG_TIMEOUT_MS },
    );
    const { size } = await stat(webpPath);
    if (size <= STICKER_MAX_BYTES) {
      fits = true;
      break;
    }
  }
  if (!fits) {
    throw new StickerTooLargeError();
  }

  const oggPath = join(workDir, "sound.ogg");
  await runBinary(buildAudioArgs({ input: inputPath, output: oggPath, seconds: audioSeconds }), {
    timeoutMs: FFMPEG_TIMEOUT_MS,
  });

  const webp = await readBuffer(webpPath);
  const ogg = await readBuffer(oggPath);
  return {
    webp,
    ogg,
    videoSeconds,
    audioSeconds,
    trimmed: duration > maxSoundSeconds || duration > STICKER_MAX_SECONDS,
  };
}

function readBuffer(path: string): Promise<Buffer> {
  return readFile(path);
}

export async function writeInput(workDir: string, data: Buffer): Promise<string> {
  const path = join(workDir, "input.bin");
  await writeFile(path, data);
  return path;
}
