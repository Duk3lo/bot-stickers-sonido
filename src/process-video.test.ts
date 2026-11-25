import { test } from "node:test";
import assert from "node:assert/strict";
import { FfmpegError } from "./ffmpeg.js";
import { imageSecondsAttempts, planClip } from "./process-video.js";

test("sin ajustes se usa todo el video con los límites de siempre", () => {
  assert.deepEqual(planClip(20, 10, {}), { start: 0, end: 20, videoSeconds: 10, audioSeconds: 10 });
  assert.deepEqual(planClip(4, 10, {}), { start: 0, end: 4, videoSeconds: 4, audioSeconds: 4 });
});

test("el tramo acota el video y el audio", () => {
  assert.deepEqual(planClip(30, 10, { start: 2, end: 7 }), { start: 2, end: 7, videoSeconds: 5, audioSeconds: 5 });
});

test("sonido acorta el audio sin tocar el video", () => {
  assert.deepEqual(planClip(30, 10, { start: 0, end: 6, sound: 3 }), { start: 0, end: 6, videoSeconds: 6, audioSeconds: 3 });
});

test("sonido explícito puede superar la imagen, acotado por el máximo", () => {
  assert.deepEqual(planClip(30, 20, { sound: 15 }), { start: 0, end: 30, videoSeconds: 10, audioSeconds: 15 });
  assert.deepEqual(planClip(30, 12, { sound: 15 }), { start: 0, end: 30, videoSeconds: 10, audioSeconds: 12 });
});

test("un fin más allá del video se recorta a su duración", () => {
  assert.deepEqual(planClip(5, 10, { start: 1, end: 50 }), { start: 1, end: 5, videoSeconds: 4, audioSeconds: 4 });
});

test("con un tope de imagen menor, el sonido por defecto sigue a la imagen", () => {
  assert.deepEqual(planClip(58, 60, {}, 8), { start: 0, end: 58, videoSeconds: 8, audioSeconds: 8 });
  assert.deepEqual(planClip(58, 60, { sound: 30 }, 6), { start: 0, end: 58, videoSeconds: 6, audioSeconds: 30 });
});

test("si la imagen no cabe se reintenta con duraciones más cortas", () => {
  assert.deepEqual(imageSecondsAttempts(10), [10, 8, 6, 5, 4, 3]);
  assert.deepEqual(imageSecondsAttempts(7), [7, 6, 5, 4, 3]);
  assert.deepEqual(imageSecondsAttempts(4), [4, 3]);
  assert.deepEqual(imageSecondsAttempts(2), [2]);
});

test("un inicio fuera del video da un error en español", () => {
  assert.throws(() => planClip(5, 10, { start: 5 }), FfmpegError);
});
