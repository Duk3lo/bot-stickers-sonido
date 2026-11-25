import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPairingCode, pairingCodeInstructions, qrInstructions } from "./vinculacion.js";

test("formatea el código de 8 caracteres como ABCD-EFGH", () => {
  assert.equal(formatPairingCode("ABCD1234"), "ABCD-1234");
  assert.equal(formatPairingCode("abcd-1234"), "ABCD-1234");
});

test("deja intacto un código con longitud inesperada", () => {
  assert.equal(formatPairingCode("ABC"), "ABC");
});

test("las instrucciones mencionan los pasos de WhatsApp", () => {
  assert.match(qrInstructions(), /Vincular un dispositivo/);
  const text = pairingCodeInstructions("ABCD1234");
  assert.match(text, /ABCD-1234/);
  assert.match(text, /Vincular con número de teléfono/);
});
