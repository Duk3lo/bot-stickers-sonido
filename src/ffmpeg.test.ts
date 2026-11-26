import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAudioArgs,
  buildAudioProbeArgs,
  buildConversorArgs,
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

test("la sonda de audio lista solo las pistas de audio del archivo", () => {
  const args = buildAudioProbeArgs("in.bin");
  assert.equal(valueAfter(args, "-select_streams"), "a");
  assert.equal(valueAfter(args, "-show_entries"), "stream=index");
  assert.equal(args.at(-1), "in.bin");
});

test("el tramo se pasa como -ss y -to separados antes de la entrada, en sticker y audio", () => {
  const sticker = buildVideoStickerArgs({ input: "in", output: "o.webp", seconds: 5, fps: 15, quality: 60, start: 2, end: 7 });
  const audio = buildAudioArgs({ input: "in", output: "o.ogg", seconds: 5, start: 2, end: 7 });
  for (const args of [sticker, audio]) {
    assert.equal(valueAfter(args, "-ss"), "2");
    assert.equal(valueAfter(args, "-to"), "7");
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"));
    assert.ok(args.indexOf("-to") < args.indexOf("-i"));
  }
});

test("sin tramo no se añaden -ss ni -to", () => {
  const args = buildAudioArgs({ input: "in", output: "o.ogg", seconds: 5 });
  assert.equal(args.includes("-ss"), false);
  assert.equal(args.includes("-to"), false);
});

test("rechaza un tramo inválido", () => {
  assert.throws(() => buildAudioArgs({ input: "a", output: "b", seconds: 2, start: -1 }), RangeError);
  assert.throws(() => buildAudioArgs({ input: "a", output: "b", seconds: 2, start: 5, end: 5 }), RangeError);
});

test("la CLI recibe el preset de sticker, la salida, el inicio y la duración como argumentos separados", () => {
  const hostile = "video; rm -rf ~ $(id).mp4";
  const args = buildConversorArgs({ input: hostile, output: "o.webp", start: 2.5, seconds: 5 });
  assert.deepEqual(args, [hostile, "--preset", "whatsapp-sticker", "-o", "o.webp", "--start", "2.5", "--max-seconds", "5"]);
});

test("la CLI nunca recibe más de 8 segundos y rechaza valores inválidos", () => {
  const args = buildConversorArgs({ input: "in", output: "o.webp", start: 0, seconds: 30 });
  assert.equal(valueAfter(args, "--max-seconds"), String(STICKER_MAX_SECONDS));
  assert.throws(() => buildConversorArgs({ input: "a", output: "b", start: -1, seconds: 2 }), RangeError);
  assert.throws(() => buildConversorArgs({ input: "a", output: "b", start: 0, seconds: 0 }), RangeError);
});

test("con recorte se corta un cuadrado antes de escalar y no hace falta relleno", () => {
  const args = buildVideoStickerArgs({ input: "a", output: "b", seconds: 5, fps: 15, quality: 60, crop: { zoom: 2, x: 0.25, y: 0.5 } });
  const filter = args[args.indexOf("-vf") + 1] ?? "";
  assert.equal(
    filter,
    "fps=15,crop=w='min(iw,ih)/2':h='min(iw,ih)/2':x='clip(iw*0.25-ow/2,0,iw-ow)':y='clip(ih*0.5-oh/2,0,ih-oh)',scale=512:512:flags=lanczos,format=rgba",
  );
});
