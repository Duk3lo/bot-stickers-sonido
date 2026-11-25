import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAudioArgs,
  buildProbeArgs,
  buildVideoStickerArgs,
  STICKER_MAX_SECONDS,
} from "./ffmpeg.js";

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("el sticker es WebP animado de 512x512 sin audio", () => {
  const args = buildVideoStickerArgs({ input: "/tmp/in.bin", output: "/tmp/out.webp", seconds: 5, fps: 15, quality: 60 });
  assert.equal(valueAfter(args, "-c:v"), "libwebp");
  assert.equal(valueAfter(args, "-loop"), "0");
  assert.ok(args.includes("-an"));
  assert.equal(args.at(-1), "/tmp/out.webp");
  const filter = valueAfter(args, "-vf") ?? "";
  assert.match(filter, /scale=512:512/);
  assert.match(filter, /pad=512:512/);
  assert.match(filter, /fps=15/);
});

test("el sticker nunca dura más de 8 segundos", () => {
  const args = buildVideoStickerArgs({ input: "a", output: "b", seconds: 30, fps: 15, quality: 60 });
  assert.equal(valueAfter(args, "-t"), String(STICKER_MAX_SECONDS));
});

test("el audio es OGG Opus mono a 48 kHz sin vídeo, con el límite de tiempo pedido", () => {
  const args = buildAudioArgs({ input: "in", output: "out.ogg", seconds: 10 });
  assert.equal(valueAfter(args, "-c:a"), "libopus");
  assert.equal(valueAfter(args, "-ac"), "1");
  assert.equal(valueAfter(args, "-ar"), "48000");
  assert.equal(valueAfter(args, "-f"), "ogg");
  assert.equal(valueAfter(args, "-t"), "10");
  assert.ok(args.includes("-vn"));
});

test("los argumentos se pasan como elementos separados, sin interpretar la entrada", () => {
  const hostile = "video; rm -rf ~ $(id).mp4";
  const args = buildAudioArgs({ input: hostile, output: "out.ogg", seconds: 3 });
  assert.equal(args[args.indexOf("-i") + 1], hostile);
});

test("rechaza valores fuera de rango", () => {
  assert.throws(() => buildAudioArgs({ input: "a", output: "b", seconds: 0 }), RangeError);
  assert.throws(
    () => buildVideoStickerArgs({ input: "a", output: "b", seconds: 2, fps: 15, quality: 101 }),
    RangeError,
  );
  assert.throws(
    () => buildVideoStickerArgs({ input: "a", output: "b", seconds: 2, fps: 0, quality: 50 }),
    RangeError,
  );
});

test("la sonda pide solo la duración", () => {
  assert.deepEqual(buildProbeArgs("x.mp4"), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "x.mp4"]);
});
