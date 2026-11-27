import { test } from "node:test";
import assert from "node:assert/strict";
import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { handleMessage, imageShorterMessage, isOwnChatVideo, uploadUnlessPaused, type BotContext } from "./bot.js";
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
  controlPort: 8787,
  listenOnNetwork: true,
  ownChatMode: false,
};

function contextoCon(configuracion: Config): BotContext {
  return {
    config: configuracion,
    registry: new AudioStickerRegistry(),
    gate: new JobGate(),
    sentIds: new Set(),
    log: logger,
  };
}

async function respuestasA(
  message: WAMessage["message"],
  pausa = new AbortController(),
  alEnviar: () => void = () => {},
): Promise<unknown[]> {
  const enviados: unknown[] = [];
  const sock = {
    sendMessage: async (_chat: string, content: unknown) => {
      enviados.push(content);
      alEnviar();
    },
  } as unknown as WASocket;
  const mensaje = { key: { remoteJid: "34600111222@s.whatsapp.net", fromMe: false }, message } as WAMessage;
  await handleMessage(sock, mensaje, contextoCon(config), pausa.signal);
  return enviados;
}

test("en pausa no responde nada", async () => {
  const pausa = new AbortController();
  pausa.abort();
  assert.deepEqual(await respuestasA({ conversation: "ayuda" }, pausa), []);
});

test("si se pausa mientras procesa, no envía el resultado ni avisos", async () => {
  const pausa = new AbortController();
  const enviados = await respuestasA({ videoMessage: { mimetype: "video/mp4" } }, pausa, () => pausa.abort());
  assert.deepEqual(enviados, [{ text: "Procesando el video…" }]);
});

test("una subida que termina con el bot en pausa no llega a enviarse", async () => {
  const pausa = new AbortController();
  const sock = {
    waUploadToServer: async () => {
      pausa.abort();
      return { mediaUrl: "u", directPath: "d" };
    },
  } as unknown as WASocket;
  const subir = uploadUnlessPaused(sock, pausa.signal);
  await assert.rejects(subir("ruta", { mediaType: "sticker", fileEncSha256B64: "x" }));
});

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

const YO = { id: "34600999000:12@s.whatsapp.net", lid: "99887766554433:12@lid" };
const MI_NUMERO = "34600999000@s.whatsapp.net";
const MI_LID = "99887766554433@lid";
const VIDEO = { videoMessage: { mimetype: "video/mp4" } };

function mensajePropio(key: Partial<WAMessage["key"]> = {}, message: WAMessage["message"] = VIDEO): WAMessage {
  return { key: { id: "abc", remoteJid: MI_NUMERO, fromMe: true, ...key }, message } as WAMessage;
}

test("chat propio: acepta videos enviados al chat consigo mismo, por número o LID", () => {
  for (const remoteJid of [MI_NUMERO, MI_LID]) {
    assert.equal(isOwnChatVideo(YO, mensajePropio({ remoteJid }), new Set()), true, remoteJid);
  }
  const documento = { documentMessage: { mimetype: "video/mp4" } };
  assert.equal(isOwnChatVideo(YO, mensajePropio({}, documento), new Set()), true);
});

test("chat propio: ignora otros chats, aunque remoteJidAlt sea el número propio", () => {
  const casos: WAMessage[] = [
    // Sent by me to a contact: the alternate address is the sender's, that is, mine.
    mensajePropio({ remoteJid: "11223344556677@lid", remoteJidAlt: MI_NUMERO }),
    mensajePropio({ remoteJid: "34600111222@s.whatsapp.net", remoteJidAlt: MI_LID }),
    mensajePropio({ remoteJid: "34600111222@s.whatsapp.net", fromMe: false }),
    mensajePropio({ fromMe: false }),
    mensajePropio({ remoteJid: "120363000@g.us", participant: MI_NUMERO }),
    mensajePropio({ remoteJid: "status@broadcast" }),
    mensajePropio({ remoteJid: YO.id }),
  ];
  for (const mensaje of casos) {
    assert.equal(isOwnChatVideo(YO, mensaje, new Set()), false, JSON.stringify(mensaje.key));
  }
  assert.equal(isOwnChatVideo(undefined, mensajePropio(), new Set()), false);
});

test("chat propio: ignora texto, stickers y otros documentos", () => {
  for (const content of [
    { conversation: "ayuda" },
    { stickerMessage: {} },
    { documentMessage: { mimetype: "application/pdf" } },
  ]) {
    assert.equal(isOwnChatVideo(YO, mensajePropio({}, content), new Set()), false);
  }
});

async function enviadosEnChatPropio(mensaje: WAMessage, contexto: BotContext) {
  const enviados: { content: unknown; messageId: string | undefined }[] = [];
  const sock = {
    user: YO,
    sendMessage: async (_chat: string, content: unknown, options?: { messageId?: string }) => {
      // The id must be known before sending: the echo may arrive before sendMessage resolves.
      assert.ok(options?.messageId && contexto.sentIds.has(options.messageId));
      enviados.push({ content, messageId: options.messageId });
    },
  } as unknown as WASocket;
  await handleMessage(sock, mensaje, contexto, new AbortController().signal);
  return enviados;
}

const CHAT_PROPIO: Config = { ...config, ownChatMode: true, allowedNumbers: new Set(["34600111222"]) };
const VIDEO_ENORME = { videoMessage: { mimetype: "video/mp4", fileLength: 99_000_000 } };

test("chat propio: no responde a los números autorizados ni a textos propios", async () => {
  const ajeno = mensajePropio({ remoteJid: "34600111222@s.whatsapp.net", fromMe: false }, VIDEO_ENORME);
  assert.deepEqual(await enviadosEnChatPropio(ajeno, contextoCon(CHAT_PROPIO)), []);
  const texto = mensajePropio({}, { conversation: "ayuda" });
  assert.deepEqual(await enviadosEnChatPropio(texto, contextoCon(CHAT_PROPIO)), []);
});

test("chat propio: los errores de ajustes no sugieren la ayuda", async () => {
  const video = mensajePropio({}, { videoMessage: { mimetype: "video/mp4", caption: "sonido=99" } });
  const enviados = await enviadosEnChatPropio(video, contextoCon(CHAT_PROPIO));
  assert.equal(enviados.length, 1);
  assert.doesNotMatch(textoDe(enviados.map(({ content }) => content)), /ayuda/);
});

test("chat propio: el bot nunca reacciona a lo que él mismo envía", async () => {
  const contexto = contextoCon(CHAT_PROPIO);
  const [respuesta] = await enviadosEnChatPropio(mensajePropio({}, VIDEO_ENORME), contexto);
  assert.ok(respuesta?.messageId);
  // Even an echo that looked like a video is discarded by its id.
  const eco = mensajePropio({ id: respuesta.messageId }, VIDEO_ENORME);
  assert.equal(isOwnChatVideo(YO, eco, contexto.sentIds), false);
  assert.deepEqual(await enviadosEnChatPropio(eco, contexto), []);
});

test("en modo normal los mensajes propios se siguen ignorando", async () => {
  const mensaje = mensajePropio({ remoteJid: "34600111222@s.whatsapp.net" });
  assert.deepEqual(await enviadosEnChatPropio(mensaje, contextoCon(config)), []);
});

async function rafaga(contexto: BotContext, mensajes: WAMessage[]): Promise<number> {
  let enviados = 0;
  const sock = {
    user: YO,
    sendMessage: async () => {
      enviados += 1;
    },
  } as unknown as WASocket;
  for (const mensaje of mensajes) {
    await handleMessage(sock, mensaje, contexto, new AbortController().signal);
  }
  return enviados;
}

function deAutorizado(message: WAMessage["message"]): WAMessage {
  return { key: { remoteJid: "34600111222@s.whatsapp.net", fromMe: false }, message } as WAMessage;
}

const AJUSTES_ERRONEOS = { videoMessage: { mimetype: "video/mp4", caption: "sonido=99" } };

test("una ráfaga de textos o ajustes erróneos no recibe una respuesta por mensaje", async () => {
  for (const content of [{ extendedTextMessage: { text: "hola" } }, { conversation: "hola" }, AJUSTES_ERRONEOS]) {
    const mensajes = Array.from({ length: 20 }, () => deAutorizado(content));
    assert.equal(await rafaga(contextoCon(config), mensajes), 1, JSON.stringify(content));
  }
});

test("mezclando tipos, un chat no pasa del tope de respuestas sin trabajo", async () => {
  const contexto = contextoCon(config);
  contexto.gate.tryStart("34600111222@s.whatsapp.net");
  const tipos = [
    { extendedTextMessage: { text: "ayuda" } },
    { conversation: "hola" },
    AJUSTES_ERRONEOS,
    VIDEO,
  ];
  const mensajes = Array.from({ length: 5 }, () => tipos.map(deAutorizado)).flat();
  assert.equal(await rafaga(contexto, mensajes), 3);
});

test("los avisos de ocupado y de límite alcanzado tampoco se repiten", async () => {
  const ocupado = contextoCon(config);
  ocupado.gate.tryStart("34600111222@s.whatsapp.net");
  assert.equal(await rafaga(ocupado, [deAutorizado(VIDEO), deAutorizado(VIDEO)]), 1);
  const limitado = contextoCon(config);
  for (let i = 0; i < 5; i += 1) {
    limitado.gate.tryStart("34600111222@s.whatsapp.net");
    limitado.gate.finish("34600111222@s.whatsapp.net");
  }
  assert.equal(await rafaga(limitado, [deAutorizado(VIDEO), deAutorizado(VIDEO)]), 1);
});

test("chat propio: reactivar no repite el mismo error de ajustes", async () => {
  const mensajes = [1, 2, 3].map(() => mensajePropio({}, AJUSTES_ERRONEOS));
  assert.equal(await rafaga(contextoCon(CHAT_PROPIO), mensajes), 1);
});
