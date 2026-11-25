import { test } from "node:test";
import assert from "node:assert/strict";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { handleMessage, imageShorterMessage } from "./bot.js";
import type { Config } from "./config.js";
import { JobGate } from "./job-gate.js";
import { logger } from "./logger.js";
import { AudioStickerRegistry } from "./sound-sticker.js";

const config: Config = {
  allowedNumbers: new Set(["34600111222"]),
  maxSoundSeconds: 10,
  authDir: "./auth",
  pairingPhone: undefined,
  wireFormat: "sticker-field-26",
  conversorBin: undefined,
};

async function respuestasA(message: WAMessage["message"]): Promise<unknown[]> {
  const enviados: unknown[] = [];
  const sock = {
    sendMessage: async (_chat: string, content: unknown) => {
      enviados.push(content);
    },
  } as unknown as WASocket;
  const mensaje = { key: { remoteJid: "34600111222@s.whatsapp.net", fromMe: false }, message } as WAMessage;
  await handleMessage(sock, mensaje, config, new AudioStickerRegistry(), new JobGate(), logger);
  return enviados;
}

test("un mensaje sin contenido no recibe respuesta ni falla", async () => {
  assert.deepEqual(await respuestasA(undefined), []);
});

test("reacciones y mensajes de protocolo no reciben respuesta", async () => {
  assert.deepEqual(await respuestasA({ reactionMessage: { text: "👍" } }), []);
  assert.deepEqual(await respuestasA({ protocolMessage: {} }), []);
});

test("un texto recibe la ayuda", async () => {
  const enviados = await respuestasA({ extendedTextMessage: { text: "hola" } });
  assert.equal(enviados.length, 1);
});

function textoDe(enviados: unknown[]): string {
  return (enviados[0] as { text: string }).text;
}

test("la palabra «ayuda» responde con el formato de ajustes", async () => {
  const enviados = await respuestasA({ conversation: "ayuda" });
  assert.equal(enviados.length, 1);
  assert.match(textoDe(enviados), /inicio=/);
});

test("el texto de ayuda general también explica los ajustes", async () => {
  const enviados = await respuestasA({ extendedTextMessage: { text: "hola" } });
  assert.match(textoDe(enviados), /inicio=/);
});

test("un video con ajustes inválidos recibe los errores y no se procesa", async () => {
  for (const content of [
    { videoMessage: { mimetype: "video/mp4", caption: "volumen=3 sonido=99" } },
    { documentMessage: { mimetype: "video/mp4", caption: "volumen=3 sonido=99" } },
  ]) {
    const enviados = await respuestasA(content);
    assert.equal(enviados.length, 1);
    assert.match(textoDe(enviados), /volumen=3/);
    assert.match(textoDe(enviados), /sonido/);
    assert.match(textoDe(enviados), /ayuda/);
  }
});

test("avisa de que la imagen es más corta cuando el audio dura más", () => {
  assert.equal(
    imageShorterMessage(2.34, 5),
    "La imagen dura 2.3 s; el resto del sonido suena con la imagen quieta.",
  );
});

test("no avisa cuando el audio no dura más que la imagen", () => {
  assert.equal(imageShorterMessage(5, 5), undefined);
  assert.equal(imageShorterMessage(5, 3), undefined);
});
