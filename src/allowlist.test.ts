import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedJid, phoneFromJid } from "./allowlist.js";

const allowed = new Set(["34600111222"]);

test("permite un chat privado de un número de la lista", () => {
  assert.equal(isAllowedJid("34600111222@s.whatsapp.net", allowed), true);
});

test("ignora los números que no están en la lista", () => {
  assert.equal(isAllowedJid("34699999999@s.whatsapp.net", allowed), false);
});

test("reconoce el sufijo de dispositivo", () => {
  assert.equal(isAllowedJid("34600111222:12@s.whatsapp.net", allowed), true);
  assert.equal(phoneFromJid("34600111222:12@s.whatsapp.net"), "34600111222");
});

test("rechaza grupos, difusiones, LID y JIDs vacíos", () => {
  assert.equal(isAllowedJid("34600111222-1234@g.us", allowed), false);
  assert.equal(isAllowedJid("status@broadcast", allowed), false);
  assert.equal(isAllowedJid("34600111222@lid", allowed), false);
  assert.equal(isAllowedJid("", allowed), false);
  assert.equal(isAllowedJid(undefined, allowed), false);
  assert.equal(isAllowedJid("@s.whatsapp.net", allowed), false);
});

test("no confunde un número que solo contiene la lista como prefijo", () => {
  assert.equal(isAllowedJid("346001112223@s.whatsapp.net", allowed), false);
});
