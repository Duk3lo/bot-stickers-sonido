import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig, normalizePhone } from "./config.js";

test("carga valores por defecto con ALLOWED_NUMBERS mínimo", () => {
  const config = loadConfig({ ALLOWED_NUMBERS: "34600111222" });
  assert.deepEqual([...config.allowedNumbers], ["34600111222"]);
  assert.equal(config.maxSoundSeconds, 10);
  assert.equal(config.authDir, "./auth");
  assert.equal(config.pairingPhone, undefined);
  assert.equal(config.wireFormat, "sticker-field-26");
});

test("normaliza espacios, signos y guiones en la lista de números", () => {
  const config = loadConfig({ ALLOWED_NUMBERS: " +34 600-111-222 , 5215512345678 " });
  assert.deepEqual([...config.allowedNumbers].sort(), ["34600111222", "5215512345678"]);
  assert.equal(normalizePhone("+34 (600) 111-222"), "34600111222");
});

test("falla con mensaje en español si falta ALLOWED_NUMBERS", () => {
  assert.throws(
    () => loadConfig({}),
    (error: unknown) =>
      error instanceof ConfigError && /Falta ALLOWED_NUMBERS/.test(error.message),
  );
});

test("rechaza un número de la lista que no es válido", () => {
  assert.throws(
    () => loadConfig({ ALLOWED_NUMBERS: "34600111222,abc" }),
    (error: unknown) => error instanceof ConfigError && /número no válido: "abc"/.test(error.message),
  );
});

test("MAX_SOUND_SECONDS acepta solo enteros entre 1 y 10", () => {
  assert.equal(loadConfig({ ALLOWED_NUMBERS: "34600111222", MAX_SOUND_SECONDS: "7" }).maxSoundSeconds, 7);
  for (const bad of ["0", "11", "2.5", "diez"]) {
    assert.throws(
      () => loadConfig({ ALLOWED_NUMBERS: "34600111222", MAX_SOUND_SECONDS: bad }),
      (error: unknown) => error instanceof ConfigError && /MAX_SOUND_SECONDS/.test(error.message),
      `debería rechazar ${bad}`,
    );
  }
});

test("informa de todos los problemas a la vez", () => {
  assert.throws(
    () => loadConfig({ ALLOWED_NUMBERS: "x", MAX_SOUND_SECONDS: "99", SOUND_WIRE_FORMAT: "otro" }),
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
    ALLOWED_NUMBERS: "34600111222",
    PAIRING_PHONE: "+34 600 111 333",
    AUTH_DIR: "/var/lib/bot/auth",
  });
  assert.equal(config.pairingPhone, "34600111333");
  assert.equal(config.authDir, "/var/lib/bot/auth");
});
