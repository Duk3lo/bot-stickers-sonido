import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "@whiskeysockets/baileys";
import protobuf from "protobufjs/minimal.js";

const { Writer } = protobuf;
type Writer = protobuf.Writer;
import {
  AudioStickerRegistry,
  encodeStickerWithAudio,
  MESSAGE_AUDIO_STICKER_FIELD,
  readFields,
  STICKER_AUDIO_FIELD,
  wrapMessageEncode,
  wrapStickerEncode,
} from "./sound-sticker.js";

type Encode<T> = (message: T, writer?: Writer) => Writer;

function originalStickerEncode(): Encode<proto.Message.IStickerMessage> {
  return proto.Message.StickerMessage.encode as unknown as Encode<proto.Message.IStickerMessage>;
}

function originalMessageEncode(): Encode<proto.IMessage> {
  return proto.Message.encode as unknown as Encode<proto.IMessage>;
}

const sha = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

function sticker(): proto.Message.IStickerMessage {
  return {
    url: "https://mmg.whatsapp.net/example",
    fileSha256: sha,
    fileEncSha256: Uint8Array.from({ length: 32 }, () => 7),
    mediaKey: Uint8Array.from({ length: 32 }, () => 9),
    mimetype: "image/webp",
    height: 512,
    width: 512,
    isAnimated: true,
    fileLength: 123456,
  };
}

function audio(): Uint8Array {
  return proto.Message.AudioMessage.encode({
    url: "https://mmg.whatsapp.net/audio",
    mimetype: "audio/ogg; codecs=opus",
    seconds: 4,
    ptt: true,
    fileLength: 9999,
  }).finish();
}

test("encodeStickerWithAudio añade el campo 26 con un AudioMessage decodificable", () => {
  const audioBytes = audio();
  const bytes = encodeStickerWithAudio(sticker(), audioBytes);

  const fields = readFields(bytes);
  const audioField = fields.find((f) => f.field === STICKER_AUDIO_FIELD);
  assert.ok(audioField, "falta el campo 26");
  assert.equal(audioField.wireType, 2);
  assert.deepEqual(Buffer.from(audioField.value as Uint8Array), Buffer.from(audioBytes));

  const decoded = proto.Message.AudioMessage.decode(audioField.value as Uint8Array);
  assert.equal(decoded.mimetype, "audio/ogg; codecs=opus");
  assert.equal(decoded.seconds, 4);
  assert.equal(decoded.ptt, true);
});

test("los campos conocidos del sticker sobreviven a la codificación", () => {
  const bytes = encodeStickerWithAudio(sticker(), audio());
  const decoded = proto.Message.StickerMessage.decode(bytes);
  assert.deepEqual(decoded.fileSha256, sha);
  assert.equal(decoded.mimetype, "image/webp");
  assert.equal(decoded.isAnimated, true);
  assert.equal(decoded.width, 512);
});

test("formato A: el encoder parcheado añade el audio solo si el sticker está registrado", () => {
  const registry = new AudioStickerRegistry();
  const patched = wrapStickerEncode(originalStickerEncode(), registry);

  const plainWriter = new Writer();
  patched(sticker(), plainWriter);
  const plain = plainWriter.finish();
  assert.equal(readFields(plain).some((f) => f.field === STICKER_AUDIO_FIELD), false);

  const audioBytes = audio();
  registry.attach(sha, audioBytes);
  const writer = new Writer();
  patched(sticker(), writer);
  assert.deepEqual(Buffer.from(writer.finish()), Buffer.from(encodeStickerWithAudio(sticker(), audioBytes)));

  registry.detach(sha);
  assert.equal(registry.lookup(sha), undefined);
});

test("formato B: el sticker con audio queda envuelto en Message.134 -> 1 -> 26", () => {
  const registry = new AudioStickerRegistry();
  const audioBytes = audio();
  registry.attach(sha, audioBytes);

  const patched = wrapMessageEncode(originalMessageEncode(), registry);
  const writer = new Writer();
  patched({ stickerMessage: sticker() }, writer);
  const bytes = writer.finish();

  const outer = readFields(bytes).find((f) => f.field === MESSAGE_AUDIO_STICKER_FIELD);
  assert.ok(outer, "falta Message.audioStickerMessage (134)");
  const futureProof = readFields(outer.value as Uint8Array);
  const innerMessage = readFields(futureProof.find((f) => f.field === 1)?.value as Uint8Array);
  const stickerBytes = innerMessage.find((f) => f.field === 26)?.value as Uint8Array | undefined;
  assert.ok(stickerBytes, "falta stickerMessage (26) dentro de 134 -> 1");
  const audioField = readFields(stickerBytes).find((f) => f.field === STICKER_AUDIO_FIELD);
  assert.deepEqual(Buffer.from(audioField?.value as Uint8Array), Buffer.from(audioBytes));

  // The top-level stickerMessage must not be duplicated outside the wrapper.
  assert.equal(readFields(bytes).some((f) => f.field === 26), false);
});
