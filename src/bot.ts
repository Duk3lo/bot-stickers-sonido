import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadMediaMessage,
  generateMessageIDV2,
  jidNormalizedUser,
  normalizeMessageContent,
  prepareWAMessageMedia,
  proto,
  type AnyMessageContent,
  type Contact,
  type MediaGenerationOptions,
  type MiscMessageGenerationOptions,
  type WAMediaUploadFunction,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { isHelpRequest, parseSettings } from "./ajustes.js";
import { isAllowedJid, phoneFromJid } from "./allowlist.js";
import type { Config } from "./config.js";
import type { JobGate, Notice } from "./job-gate.js";
import { writeInput, buildSoundSticker, StickerTooLargeError } from "./process-video.js";
import { FfmpegError } from "./ffmpeg.js";
import type { Logger } from "./logger.js";
import type { AudioStickerRegistry } from "./sound-sticker.js";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;

const MSG_HELP =
  "Envíame un video corto (o un video enviado como documento) y te devuelvo un sticker con sonido. " +
  "Puedes recortar el clip antes con la app «Conversor de stickers», opción «Sticker con sonido».\n\n" +
  "También puedes escribir ajustes en el texto del video, todos opcionales:\n" +
  "inicio=2 fin=7 sonido=5\n" +
  "• inicio y fin: segundos del tramo que quieres (admite decimales, ej. 2,5).\n" +
  "• sonido: segundos de audio, entero de 1 al máximo permitido.\n" +
  "Escribe «ayuda» para ver esto de nuevo.";
const MSG_NOT_VIDEO = "Eso no es un video. Envíame un video corto para crear el sticker.";
const MSG_TOO_LARGE = "El video supera el límite de 25 MB. Envía un clip más corto.";
const MSG_BUSY = "Ya estoy procesando un video tuyo. Espera a que termine.";
const MSG_RATE_LIMITED = "Has enviado demasiados videos seguidos. Espera unos minutos e inténtalo de nuevo.";
const MSG_PROCESSING = "Procesando el video…";
const MSG_FALLBACK =
  "No pude enviar el sticker con sonido, así que te envié el sticker animado sin audio.";
const MSG_NO_AUDIO = "Ese video no tiene sonido, así que te envié el sticker animado sin audio.";
export function imageShorterMessage(videoSeconds: number, audioSeconds: number): string | undefined {
  if (audioSeconds <= videoSeconds) return undefined;
  return `La imagen dura ${Number(videoSeconds.toFixed(1))} s; el resto del sonido suena con la imagen quieta.`;
}
const MSG_FAILED = "No pude procesar ese video. Prueba con otro archivo.";

interface VideoRef {
  readonly caption: string | undefined;
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
      caption: content.videoMessage.caption ?? undefined,
      fileLength: toNumber(content.videoMessage.fileLength),
      mimetype: content.videoMessage.mimetype ?? undefined,
    };
  }
  const document = content.documentMessage;
  if (document?.mimetype?.startsWith("video/")) {
    return {
      caption: document.caption ?? undefined,
      fileLength: toNumber(document.fileLength),
      mimetype: document.mimetype,
    };
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

/** Normal mode: private chats from the allowlist, never our own messages. */
function isFromAllowedChat(message: WAMessage, config: Config, log: Logger): boolean {
  if (message.key.fromMe) {
    return false;
  }
  const chat = message.key.remoteJid ?? "";
  if (chat.endsWith("@g.us") || chat.endsWith("@broadcast") || chat.endsWith("@newsletter")) {
    log.debug("Mensaje de grupo, difusión o canal; ignorado.");
    return false;
  }
  if (allowedPhoneFor(message, config) === undefined) {
    // Not on the allowlist: the bot stays silent so it does not reveal itself to strangers.
    log.debug("Mensaje de un remitente fuera de la lista; ignorado.");
    return false;
  }
  return true;
}

/**
 * Baileys uploads media inside sendMessage and cannot be cancelled; failing right after the upload
 * keeps a job that was paused meanwhile from being sent.
 */
export function uploadUnlessPaused(sock: WASocket, signal: AbortSignal): WAMediaUploadFunction {
  return async (...args) => {
    const uploaded = await sock.waUploadToServer(...args);
    signal.throwIfAborted();
    return uploaded;
  };
}

/**
 * True for a video the account sent to its own chat. `remoteJid` is the chat (the recipient);
 * `remoteJidAlt` is deliberately not trusted: on our own messages to a contact it may hold the
 * sender's alternate address, which is ours.
 */
export function isOwnChatVideo(
  me: Contact | undefined,
  message: WAMessage,
  sentIds: ReadonlySet<string>,
): boolean {
  const { fromMe, id, remoteJid } = message.key;
  if (!fromMe || !remoteJid || (id && sentIds.has(id))) {
    return false;
  }
  // Own ids carry a device suffix ("number:12@..."), chat ids do not.
  const isOwnChat = [me?.id, me?.lid].some((own) => own && jidNormalizedUser(own) === remoteJid);
  return isOwnChat && findVideo(message) !== undefined;
}

export interface BotContext {
  readonly config: Config;
  readonly registry: AudioStickerRegistry;
  readonly gate: JobGate;
  /** Ids of the messages the bot sends, so it never reacts to them. */
  readonly sentIds: Set<string>;
  readonly log: Logger;
}

/** Sends a message to the chat unless the bot has been paused. */
type Reply = (content: AnyMessageContent, quote?: "quoted") => Promise<void>;

/**
 * Answers one message. `signal` aborts on a manual pause or a disconnection: from then on nothing
 * is sent.
 */
export async function handleMessage(
  sock: WASocket,
  message: WAMessage,
  context: BotContext,
  signal: AbortSignal,
): Promise<void> {
  const { config, registry, gate, sentIds, log } = context;
  log.debug(
    {
      fromMe: message.key.fromMe,
      stubType: message.messageStubType,
      contentKeys: Object.keys(message.message ?? {}),
    },
    "Mensaje recibido.",
  );
  if (signal.aborted) {
    return;
  }
  if (config.ownChatMode) {
    if (!isOwnChatVideo(sock.user, message, sentIds)) {
      return;
    }
  } else if (!isFromAllowedChat(message, config, log)) {
    return;
  }

  const chat = message.key.remoteJid ?? "";
  const sender = senderOf(message);
  const reply: Reply = async (content, quote) => {
    if (signal.aborted) {
      return;
    }
    const messageId = generateMessageIDV2(sock.user?.id);
    sentIds.add(messageId);
    // sendMessage passes `upload` on to the media generation, although its type does not list it.
    const options: MiscMessageGenerationOptions & Pick<MediaGenerationOptions, "upload"> = {
      messageId,
      upload: uploadUnlessPaused(sock, signal),
      ...(quote && { quoted: message }),
    };
    await sock.sendMessage(chat, content, options);
  };
  const replyNotice = async (notice: Notice, text: string, quote?: "quoted"): Promise<void> => {
    if (gate.tryNotice(sender, notice)) {
      await reply({ text }, quote);
    }
  };
  const video = findVideo(message);
  if (!video) {
    const content = normalizeMessageContent(message.message);
    // Reactions, protocol and undecryptable messages are not conversation: do not answer them.
    if (!content || content.reactionMessage || content.protocolMessage) {
      log.debug("Mensaje sin contenido útil (reacción, protocolo o no descifrado); ignorado.");
      return;
    }
    const askedForHelp = isHelpRequest(content.conversation ?? content.extendedTextMessage?.text);
    if (content.conversation && !askedForHelp) {
      await replyNotice("no-es-video", MSG_NOT_VIDEO);
    } else {
      await replyNotice("ayuda", MSG_HELP);
    }
    return;
  }

  const parsed = parseSettings(video.caption, config.maxSoundSeconds);
  if (!parsed.ok) {
    const hint = config.ownChatMode ? [] : ["Escribe «ayuda» para ver el formato."];
    await replyNotice("ajustes", [...parsed.errors, ...hint].join("\n"), "quoted");
    return;
  }

  const decision = gate.tryStart(sender);
  if (decision === "busy") {
    await replyNotice("ocupado", MSG_BUSY, "quoted");
    return;
  }
  if (decision === "rate-limited") {
    await replyNotice("limite", MSG_RATE_LIMITED, "quoted");
    return;
  }

  let workDir: string | undefined;
  try {
    if (video.fileLength !== undefined && video.fileLength > MAX_INPUT_BYTES) {
      await reply({ text: MSG_TOO_LARGE }, "quoted");
      return;
    }
    if (!config.ownChatMode) {
      await reply({ text: MSG_PROCESSING }, "quoted");
    }
    signal.throwIfAborted();

    workDir = await mkdtemp(join(tmpdir(), "sound-sticker-"));
    const data = await downloadMediaMessage(message, "buffer", {}, {
      logger: log.child({ module: "media" }, { level: "warn" }),
      reuploadRequest: sock.updateMediaMessage,
    });
    signal.throwIfAborted();
    if (data.length > MAX_INPUT_BYTES) {
      await reply({ text: MSG_TOO_LARGE }, "quoted");
      return;
    }
    const inputPath = await writeInput(workDir, data);
    const files = await buildSoundSticker(inputPath, workDir, config.maxSoundSeconds, parsed.settings, config.conversorBin);
    log.info(
      { videoSeconds: files.videoSeconds, audioSeconds: files.audioSeconds, trimmed: files.trimmed },
      "Sticker con sonido generado.",
    );

    signal.throwIfAborted();

    if (files.ogg === undefined) {
      await reply({ sticker: files.webp, isAnimated: true }, "quoted");
      await reply({ text: MSG_NO_AUDIO }, "quoted");
      return;
    }
    await sendSoundSticker(sock, reply, files.webp, files.ogg, registry, log, signal);
    const aviso = imageShorterMessage(files.videoSeconds, files.audioSeconds);
    if (aviso !== undefined) {
      await reply({ text: aviso }, "quoted");
    }
  } catch (error) {
    if (signal.aborted) {
      log.info("El bot se pausó: descarto el trabajo en curso.");
      return;
    }
    const text =
      error instanceof StickerTooLargeError || error instanceof FfmpegError ? error.message : MSG_FAILED;
    log.warn({ err: error }, "No se pudo generar el sticker.");
    await reply({ text }, "quoted");
  } finally {
    gate.finish(sender);
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

async function sendSoundSticker(
  sock: WASocket,
  reply: Reply,
  webp: Buffer,
  ogg: Buffer,
  registry: AudioStickerRegistry,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const stickerSha = sha256(webp);
  try {
    const prepared = await prepareWAMessageMedia(
      { audio: ogg, ptt: true, mimetype: "audio/ogg; codecs=opus" },
      { upload: uploadUnlessPaused(sock, signal), logger: log.child({ module: "media" }, { level: "warn" }) },
    );
    if (!prepared.audioMessage) {
      throw new Error("prepareWAMessageMedia no devolvió audioMessage");
    }
    const audioBytes = proto.Message.AudioMessage.encode(prepared.audioMessage).finish();

    registry.attach(stickerSha, audioBytes);
    try {
      await reply({ sticker: webp, isAnimated: true }, "quoted");
    } finally {
      registry.detach(stickerSha);
    }
    log.info("Sticker con sonido enviado.");
  } catch (error) {
    signal.throwIfAborted();
    log.warn({ err: error }, "Fallo al enviar el sticker con sonido; envío el animado sin audio.");
    await reply({ sticker: webp, isAnimated: true }, "quoted");
    await reply({ text: MSG_FALLBACK }, "quoted");
  }
}
