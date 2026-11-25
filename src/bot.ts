import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  normalizeMessageContent,
  prepareWAMessageMedia,
  proto,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { isAllowedJid, phoneFromJid } from "./allowlist.js";
import type { Config } from "./config.js";
import { ConfigError } from "./config.js";
import { JobGate } from "./job-gate.js";
import { writeInput, buildSoundSticker, StickerTooLargeError } from "./process-video.js";
import { FfmpegError } from "./ffmpeg.js";
import { logger as rootLogger, type Logger } from "./logger.js";
import { AudioStickerRegistry, installSoundStickerPatch } from "./sound-sticker.js";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const PAIRING_CODE_DELAY_MS = 3_000;
const RECONNECT_DELAY_MS = 5_000;

const MSG_HELP =
  "Envíame un video corto (o un video enviado como documento) y te devuelvo un sticker con sonido. " +
  "Puedes recortar el clip antes con la app «Conversor de stickers», opción «Sticker con sonido».";
const MSG_NOT_VIDEO = "Eso no es un video. Envíame un video corto para crear el sticker.";
const MSG_TOO_LARGE = "El video supera el límite de 25 MB. Envía un clip más corto.";
const MSG_BUSY = "Ya estoy procesando un video tuyo. Espera a que termine.";
const MSG_RATE_LIMITED = "Has enviado demasiados videos seguidos. Espera unos minutos e inténtalo de nuevo.";
const MSG_PROCESSING = "Procesando el video…";
const MSG_FALLBACK =
  "No pude enviar el sticker con sonido, así que te envié el sticker animado sin audio.";
const MSG_FAILED = "No pude procesar ese video. Prueba con otro archivo.";

interface VideoRef {
  readonly fileLength: number | undefined;
  readonly mimetype: string | undefined;
}

/** Finds a video in a message: a video, or a document with a video MIME type. */
function findVideo(message: WAMessage): VideoRef | undefined {
  const content = normalizeMessageContent(message.message);
  if (!content) {
    return undefined;
  }
  if (content.videoMessage) {
    return {
      fileLength: toNumber(content.videoMessage.fileLength),
      mimetype: content.videoMessage.mimetype ?? undefined,
    };
  }
  const document = content.documentMessage;
  if (document?.mimetype?.startsWith("video/")) {
    return { fileLength: toNumber(document.fileLength), mimetype: document.mimetype };
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return (value as { toNumber(): number }).toNumber();
  }
  return undefined;
}

function sha256(bytes: Buffer): Uint8Array {
  return createHash("sha256").update(bytes).digest();
}

function senderOf(message: WAMessage): string {
  return message.key.remoteJid ?? "";
}

/** Only private chats count: the sender's phone must come from remoteJid or its alternate JID. */
function allowedPhoneFor(message: WAMessage, config: Config): string | undefined {
  const candidates = [message.key.remoteJid, message.key.remoteJidAlt];
  for (const jid of candidates) {
    if (isAllowedJid(jid, config.allowedNumbers)) {
      return phoneFromJid(jid);
    }
  }
  return undefined;
}

export interface BotDeps {
  readonly config: Config;
  readonly logger?: Logger;
}

/** Starts the bot and keeps it connected until the session is logged out. */
export async function startBot(deps: BotDeps): Promise<void> {
  const log = deps.logger ?? rootLogger;
  const registry = new AudioStickerRegistry();
  installSoundStickerPatch(deps.config.wireFormat, registry);
  const gate = new JobGate();

  for (;;) {
    const outcome = await connectOnce(deps, registry, gate, log);
    if (outcome === "logged-out") {
      log.error("La sesión se cerró en WhatsApp. Borra AUTH_DIR y vuelve a vincular el dispositivo.");
      return;
    }
    log.warn("Conexión perdida. Reintentando…");
    await delay(RECONNECT_DELAY_MS);
  }
}

async function connectOnce(
  deps: BotDeps,
  registry: AudioStickerRegistry,
  gate: JobGate,
  log: Logger,
): Promise<"logged-out" | "closed"> {
  const { state, saveCreds } = await useMultiFileAuthState(deps.config.authDir);

  if (!state.creds.registered && deps.config.pairingPhone === undefined) {
    throw new ConfigError(
      "Falta PAIRING_PHONE: es la primera vez que se inicia sesión. Indica tu número con código de país.",
    );
  }

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("Chrome"),
    logger: log.child({ module: "baileys" }, { level: "warn" }),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  if (!state.creds.registered && deps.config.pairingPhone) {
    const phone = deps.config.pairingPhone;
    setTimeout(() => {
      sock
        .requestPairingCode(phone)
        .then((code) => {
          log.info(
            { code },
            `Código de vinculación: ${code}. En WhatsApp: Dispositivos vinculados > Vincular con número de teléfono.`,
          );
        })
        .catch((error: unknown) => {
          log.error({ err: error }, "No pude pedir el código de vinculación.");
        });
    }, PAIRING_CODE_DELAY_MS);
  }

  return new Promise((resolve) => {
    sock.ev.on("connection.update", (update) => {
      if (update.connection === "open") {
        log.info("Conectado a WhatsApp.");
      }
      if (update.connection === "close") {
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        resolve(code === DisconnectReason.loggedOut ? "logged-out" : "closed");
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") {
        return;
      }
      for (const message of messages) {
        handleMessage(sock, message, deps.config, registry, gate, log).catch((error: unknown) => {
          log.error({ err: error }, "Error inesperado al procesar un mensaje.");
        });
      }
    });
  });
}

export async function handleMessage(
  sock: WASocket,
  message: WAMessage,
  config: Config,
  registry: AudioStickerRegistry,
  gate: JobGate,
  log: Logger,
): Promise<void> {
  if (message.key.fromMe) {
    return;
  }
  const chat = message.key.remoteJid ?? "";
  if (chat.endsWith("@g.us") || chat.endsWith("@broadcast") || chat.endsWith("@newsletter")) {
    return;
  }

  const phone = allowedPhoneFor(message, config);
  if (phone === undefined) {
    // Not on the allowlist: the bot stays silent so it does not reveal itself to strangers.
    log.debug("Mensaje de un remitente fuera de la lista; ignorado.");
    return;
  }

  const sender = senderOf(message);
  const video = findVideo(message);
  if (!video) {
    await sock.sendMessage(chat, { text: normalizeMessageContent(message.message)?.conversation ? MSG_NOT_VIDEO : MSG_HELP });
    return;
  }

  const decision = gate.tryStart(sender);
  if (decision === "busy") {
    await sock.sendMessage(chat, { text: MSG_BUSY }, { quoted: message });
    return;
  }
  if (decision === "rate-limited") {
    await sock.sendMessage(chat, { text: MSG_RATE_LIMITED }, { quoted: message });
    return;
  }

  let workDir: string | undefined;
  try {
    if (video.fileLength !== undefined && video.fileLength > MAX_INPUT_BYTES) {
      await sock.sendMessage(chat, { text: MSG_TOO_LARGE }, { quoted: message });
      return;
    }
    await sock.sendMessage(chat, { text: MSG_PROCESSING }, { quoted: message });

    workDir = await mkdtemp(join(tmpdir(), "sound-sticker-"));
    const data = await downloadMediaMessage(message, "buffer", {}, {
      logger: log.child({ module: "media" }, { level: "warn" }),
      reuploadRequest: sock.updateMediaMessage,
    });
    if (data.length > MAX_INPUT_BYTES) {
      await sock.sendMessage(chat, { text: MSG_TOO_LARGE }, { quoted: message });
      return;
    }
    const inputPath = await writeInput(workDir, data);
    const files = await buildSoundSticker(inputPath, workDir, config.maxSoundSeconds);
    log.info(
      { videoSeconds: files.videoSeconds, audioSeconds: files.audioSeconds, trimmed: files.trimmed },
      "Sticker con sonido generado.",
    );

    await sendSoundSticker(sock, chat, message, files.webp, files.ogg, registry, log);
  } catch (error) {
    const text =
      error instanceof StickerTooLargeError || error instanceof FfmpegError ? error.message : MSG_FAILED;
    log.warn({ err: error }, "No se pudo generar el sticker.");
    await sock.sendMessage(chat, { text }, { quoted: message });
  } finally {
    gate.finish(sender);
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

async function sendSoundSticker(
  sock: WASocket,
  chat: string,
  quoted: WAMessage,
  webp: Buffer,
  ogg: Buffer,
  registry: AudioStickerRegistry,
  log: Logger,
): Promise<void> {
  const stickerSha = sha256(webp);
  try {
    const prepared = await prepareWAMessageMedia(
      { audio: ogg, ptt: true, mimetype: "audio/ogg; codecs=opus" },
      { upload: sock.waUploadToServer, logger: log.child({ module: "media" }, { level: "warn" }) },
    );
    if (!prepared.audioMessage) {
      throw new Error("prepareWAMessageMedia no devolvió audioMessage");
    }
    const audioBytes = proto.Message.AudioMessage.encode(prepared.audioMessage).finish();

    registry.attach(stickerSha, audioBytes);
    try {
      await sock.sendMessage(chat, { sticker: webp, isAnimated: true }, { quoted });
    } finally {
      registry.detach(stickerSha);
    }
    log.info("Sticker con sonido enviado.");
  } catch (error) {
    log.warn({ err: error }, "Fallo al enviar el sticker con sonido; envío el animado sin audio.");
    await sock.sendMessage(chat, { sticker: webp, isAnimated: true }, { quoted });
    await sock.sendMessage(chat, { text: MSG_FALLBACK }, { quoted });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
