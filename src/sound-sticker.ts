/**
 * WhatsApp "sound sticker" wire format.
 *
 * Baileys does not know the fields needed to send a sticker that carries audio, so this module
 * adds them to the protobuf encoders at runtime. Two layouts are supported, selected with
 * SOUND_WIRE_FORMAT:
 *
 * - "sticker-field-26" (default): StickerMessage.audioMessage = field 26 (AudioMessage, length
 *   delimited), appended after the known fields. Layout from
 *   https://github.com/DavidRamirez206/whatsapp-sound-sticker-bot (src/sticker-audio-patch.js).
 * - "audio-sticker-134": the same sticker wrapped as Message.audioStickerMessage = field 134
 *   (FutureProofMessage) -> field 1 (Message) -> field 26 (stickerMessage). Layout from
 *   https://github.com/flextofc804/proyects-bot-/pull/101.
 *
 * Both reference implementations are MIT licensed; this file is an adaptation, not a copy.
 */
import { proto } from "@whiskeysockets/baileys";
import protobuf from "protobufjs/minimal.js";

const { Writer } = protobuf;
type Writer = protobuf.Writer;
import type { WireFormat } from "./config.js";

export const STICKER_AUDIO_FIELD = 26;
export const MESSAGE_AUDIO_STICKER_FIELD = 134;
export const MESSAGE_STICKER_FIELD = 26;
export const FUTURE_PROOF_MESSAGE_FIELD = 1;

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED64 = 1;
const WIRE_FIXED32 = 5;

type StickerEncode = (message: proto.Message.IStickerMessage, writer?: Writer) => Writer;
type MessageEncode = (message: proto.IMessage, writer?: Writer) => Writer;

/** Keeps the encoders Baileys shipped, before any patch replaces them. */
const originalStickerEncode: StickerEncode = proto.Message.StickerMessage.encode as unknown as StickerEncode;

export interface ProtoField {
  readonly field: number;
  readonly wireType: number;
  /** Raw payload for length-delimited fields, numeric value for varints, bytes for fixed fields. */
  readonly value: Uint8Array | number;
}

/** Keyed store of pre-encoded AudioMessage bytes, indexed by the sticker's fileSha256. */
export class AudioStickerRegistry {
  private readonly entries = new Map<string, Uint8Array>();

  attach(fileSha256: Uint8Array, audioMessage: Uint8Array): void {
    this.entries.set(keyOf(fileSha256), audioMessage);
  }

  detach(fileSha256: Uint8Array): void {
    this.entries.delete(keyOf(fileSha256));
  }

  lookup(fileSha256: Uint8Array | null | undefined): Uint8Array | undefined {
    return fileSha256 ? this.entries.get(keyOf(fileSha256)) : undefined;
  }
}

function keyOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function tagOf(field: number, wireType: number): number {
  return ((field << 3) | wireType) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Uint8Array.from(bytes);
}

function lengthDelimited(field: number, payload: Uint8Array): Uint8Array {
  return concat([encodeVarint(tagOf(field, WIRE_LENGTH_DELIMITED)), encodeVarint(payload.length), payload]);
}

/**
 * Bytes of a StickerMessage with its audioMessage field (26) appended.
 * Pure: it does not depend on the runtime patch.
 */
export function encodeStickerWithAudio(
  sticker: proto.Message.IStickerMessage,
  audioMessage: Uint8Array,
): Uint8Array {
  const base = originalStickerEncode(sticker, Writer.create()).finish();
  return concat([base, lengthDelimited(STICKER_AUDIO_FIELD, audioMessage)]);
}

/** Reads the top-level fields of a protobuf buffer without needing a schema. */
export function readFields(buffer: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  const readVarint = (): number => {
    let result = 0;
    let multiplier = 1;
    for (;;) {
      const byte = buffer[offset];
      if (byte === undefined) {
        throw new RangeError("Protobuf truncado: varint incompleto.");
      }
      offset += 1;
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        return result;
      }
      multiplier *= 128;
    }
  };

  while (offset < buffer.length) {
    const tag = readVarint();
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (wireType === WIRE_VARINT) {
      fields.push({ field, wireType, value: readVarint() });
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint();
      if (offset + length > buffer.length) {
        throw new RangeError("Protobuf truncado: campo de longitud excede el buffer.");
      }
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (wireType === WIRE_FIXED64 || wireType === WIRE_FIXED32) {
      const size = wireType === WIRE_FIXED64 ? 8 : 4;
      fields.push({ field, wireType, value: buffer.subarray(offset, offset + size) });
      offset += size;
    } else {
      throw new RangeError(`Protobuf no válido: tipo de cable ${wireType} no soportado.`);
    }
  }
  return fields;
}

/** Wraps StickerMessage.encode so that registered stickers also carry their audio (format A). */
export function wrapStickerEncode(original: StickerEncode, registry: AudioStickerRegistry): StickerEncode {
  return (message, writer) => {
    const target = writer ?? Writer.create();
    original(message, target);
    const audio = registry.lookup(message.fileSha256);
    if (audio !== undefined) {
      target.uint32(tagOf(STICKER_AUDIO_FIELD, WIRE_LENGTH_DELIMITED)).bytes(audio);
    }
    return target;
  };
}

/**
 * Wraps Message.encode for format B: a registered sticker is removed from its top-level field 26
 * and written inside Message.audioStickerMessage (134) -> FutureProofMessage.message (1) -> field 26.
 */
export function wrapMessageEncode(original: MessageEncode, registry: AudioStickerRegistry): MessageEncode {
  return (message, writer) => {
    const sticker = message.stickerMessage;
    const audio = sticker ? registry.lookup(sticker.fileSha256) : undefined;
    const target = writer ?? Writer.create();
    if (!sticker || audio === undefined) {
      return original(message, target);
    }

    original({ ...message, stickerMessage: null }, target);
    const stickerWithAudio = encodeStickerWithAudio(sticker, audio);
    const innerMessage = lengthDelimited(MESSAGE_STICKER_FIELD, stickerWithAudio);
    const futureProof = lengthDelimited(FUTURE_PROOF_MESSAGE_FIELD, innerMessage);
    target.uint32(tagOf(MESSAGE_AUDIO_STICKER_FIELD, WIRE_LENGTH_DELIMITED)).bytes(futureProof);
    return target;
  };
}

const PATCHED = Symbol.for("bot-stickers-sonido.sound-sticker-patch");

/**
 * Installs the encoder patch into Baileys' protobuf classes. Idempotent.
 * Must run before the first message is sent.
 */
export function installSoundStickerPatch(format: WireFormat, registry: AudioStickerRegistry): void {
  if (format === "sticker-field-26") {
    const target = proto.Message.StickerMessage as unknown as Record<PropertyKey, unknown>;
    if (target[PATCHED]) {
      return;
    }
    target["encode"] = wrapStickerEncode(originalStickerEncode, registry);
    target[PATCHED] = true;
    return;
  }

  const target = proto.Message as unknown as Record<PropertyKey, unknown>;
  if (target[PATCHED]) {
    return;
  }
  const originalMessageEncode = proto.Message.encode as unknown as MessageEncode;
  target["encode"] = wrapMessageEncode(originalMessageEncode, registry);
  target[PATCHED] = true;
}
