import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig, normalizePhone } from "./config.js";

const VALID = { ACEPTO_AVISO: "si", ALLOWED_NUMBERS: "34600111222" };
const ACCEPTED = { ACEPTO_AVISO: "si" };

test("carga valores por defecto con ALLOWED_NUMBERS mínimo", () => {
  const config = loadConfig({ ...ACCEPTED, ALLOWED_NUMBERS: "34600111222" });
  assert.deepEqual([...config.allowedNumbers], ["34600111222"]);
  assert.equal(config.maxSoundSeconds, 10);
  assert.equal(config.authDir, "./auth");
  assert.equal(config.pairingPhone, undefined);
  assert.equal(config.wireFormat, "sticker-field-26");
});

test("normaliza espacios, signos y guiones en la lista de números", () => {
  const config = loadConfig({ ...ACCEPTED, ALLOWED_NUMBERS: " +34 600-111-222 , 5215512345678 " });
  assert.deepEqual([...config.allowedNumbers].sort(), ["34600111222", "5215512345678"]);
  assert.equal(normalizePhone("+34 (600) 111-222"), "34600111222");
});

test("falla con mensaje en español si falta ALLOWED_NUMBERS", () => {
  assert.throws(
    () => loadConfig({ ...ACCEPTED }),
    (error: unknown) =>
      error instanceof ConfigError && /Falta ALLOWED_NUMBERS/.test(error.message),
  );
});

test("rechaza un número de la lista que no es válido", () => {
  assert.throws(
    () => loadConfig({ ...ACCEPTED, ALLOWED_NUMBERS: "34600111222,abc" }),
    (error: unknown) => error instanceof ConfigError && /número no válido: "abc"/.test(error.message),
  );
});

test("MAX_SOUND_SECONDS acepta solo enteros entre 1 y 60", () => {
  assert.equal(loadConfig({ ...ACCEPTED, ALLOWED_NUMBERS: "34600111222", MAX_SOUND_SECONDS: "7" }).maxSoundSeconds, 7);
  assert.equal(loadConfig({ ...ACCEPTED, ALLOWED_NUMBERS: "34600111222", MAX_SOUND_SECONDS: "60" }).maxSoundSeconds, 60);
  for (const bad of ["0", "61", "2.5", "diez"]) {
    assert.throws(
      () => loadConfig({ ...ACCEPTED, ALLOWED_NUMBERS: "34600111222", MAX_SOUND_SECONDS: bad }),
      (error: unknown) => error instanceof ConfigError && /MAX_SOUND_SECONDS/.test(error.message),
      `debería rechazar ${bad}`,
    );
  }
});

test("informa de todos los problemas a la vez", () => {
  assert.throws(
    () => loadConfig({ ...ACCEPTED, ALLOWED_NUMBERS: "x", MAX_SOUND_SECONDS: "99", SOUND_WIRE_FORMAT: "otro" }),
    (error: unknown) => {
      if (!(error instanceof ConfigError)) {
        return false;
      }
      return (
        /ALLOWED_NUMBERS/.test(error.message) &&
        /MAX_SOUND_SECONDS/.test(error.message) &&
        /SOUND_WIRE_FORMAT/.test(error.message)
      );
    },
  );
});

test("PAIRING_PHONE y AUTH_DIR se leen si están definidos", () => {
  const config = loadConfig({
    ...ACCEPTED,
    ALLOWED_NUMBERS: "34600111222",
    PAIRING_PHONE: "+34 600 111 333",
    AUTH_DIR: "/var/lib/bot/auth",
  });
  assert.equal(config.pairingPhone, "34600111333");
  assert.equal(config.authDir, "/var/lib/bot/auth");
});

test("no arranca sin ACEPTO_AVISO=si y remite a AVISO.md", () => {
  for (const value of [undefined, "", "no", "SI"]) {
    const env = value === undefined ? {} : { ACEPTO_AVISO: value };
    assert.throws(
      () => loadConfig({ ...env, ALLOWED_NUMBERS: "34600111222" }),
      (error: unknown) =>
        error instanceof ConfigError && /ACEPTO_AVISO=si/.test(error.message) && /AVISO\.md/.test(error.message),
      `debería rechazar ${String(value)}`,
    );
  }
});

test("CONVERSOR_BIN es opcional y se acepta si es una ruta absoluta existente", () => {
  assert.equal(loadConfig(VALID).conversorBin, undefined);
  assert.equal(loadConfig({ ...VALID, CONVERSOR_BIN: process.execPath }).conversorBin, process.execPath);
});

test("CONVERSOR_BIN rechaza rutas relativas o inexistentes", () => {
  for (const bin of ["conversor-stickers", "/no/existe/conversor-stickers"]) {
    assert.throws(
      () => loadConfig({ ...VALID, CONVERSOR_BIN: bin }),
      (error: unknown) => error instanceof ConfigError && /CONVERSOR_BIN/.test(error.message),
    );
  }
});

test("PAIRING_PHONE vacío o ausente es válido (vinculación por QR)", () => {
  assert.equal(loadConfig({ ...VALID, PAIRING_PHONE: "" }).pairingPhone, undefined);
  assert.equal(loadConfig({ ...VALID }).pairingPhone, undefined);
});
