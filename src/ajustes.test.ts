import { test } from "node:test";
import assert from "node:assert/strict";
import { isHelpRequest, parseSettings } from "./ajustes.js";

const MAX_SOUND = 10;

test("sin pie o con pie vacío no hay ajustes", () => {
  assert.deepEqual(parseSettings(undefined, MAX_SOUND), { ok: true, settings: {} });
  assert.deepEqual(parseSettings("   ", MAX_SOUND), { ok: true, settings: {} });
});

test("lee inicio, fin y sonido", () => {
  assert.deepEqual(parseSettings("inicio=2 fin=7 sonido=5", MAX_SOUND), {
    ok: true,
    settings: { start: 2, end: 7, sound: 5 },
  });
});

test("admite decimales con punto o coma, mayúsculas y espacios de más", () => {
  assert.deepEqual(parseSettings("  INICIO=1,5   fin=3.25 ", MAX_SOUND), {
    ok: true,
    settings: { start: 1.5, end: 3.25 },
  });
});

test("todos los ajustes son opcionales", () => {
  assert.deepEqual(parseSettings("fin=4", MAX_SOUND), { ok: true, settings: { end: 4 } });
  assert.deepEqual(parseSettings("sonido=3", MAX_SOUND), { ok: true, settings: { sound: 3 } });
});

test("rechaza claves desconocidas y fragmentos sin igual, con un error por problema", () => {
  const result = parseSettings("volumen=3 hola", MAX_SOUND);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.errors.length, 2);
});

test("rechaza valores no numéricos, negativos o repetidos", () => {
  for (const caption of ["inicio=abc", "inicio=-1", "fin=0x5", "inicio=1 inicio=2", "inicio="]) {
    assert.equal(parseSettings(caption, MAX_SOUND).ok, false, caption);
  }
});

test("inicio debe ser menor que fin, y fin mayor que cero", () => {
  assert.equal(parseSettings("inicio=5 fin=5", MAX_SOUND).ok, false);
  assert.equal(parseSettings("inicio=6 fin=2", MAX_SOUND).ok, false);
  assert.equal(parseSettings("fin=0", MAX_SOUND).ok, false);
  assert.equal(parseSettings("inicio=0 fin=1", MAX_SOUND).ok, true);
});

test("sonido es un entero de 1 al máximo configurado", () => {
  for (const caption of ["sonido=0", "sonido=11", "sonido=2.5"]) {
    assert.equal(parseSettings(caption, MAX_SOUND).ok, false, caption);
  }
  assert.equal(parseSettings("sonido=10", MAX_SOUND).ok, true);
  assert.equal(parseSettings("sonido=4", 3).ok, false);
});

test("los errores están en español y nombran el ajuste", () => {
  const result = parseSettings("sonido=99", MAX_SOUND);
  assert.ok(result.ok === false && result.errors[0]?.includes("sonido"));
});

test("la palabra suelta «ayuda» pide el formato", () => {
  assert.equal(isHelpRequest(" Ayuda "), true);
  assert.equal(isHelpRequest("ayuda por favor"), false);
  assert.equal(isHelpRequest(undefined), false);
});

test("el encuadre «recortar» lleva zoom y centro, con valores por defecto", () => {
  assert.deepEqual(parseSettings("sonido=5 encuadre=recortar", MAX_SOUND), {
    ok: true,
    settings: { sound: 5, crop: { zoom: 1, x: 0.5, y: 0.5 } },
  });
  assert.deepEqual(parseSettings("encuadre=recortar zoom=1,5 x=0.25 y=1", MAX_SOUND), {
    ok: true,
    settings: { crop: { zoom: 1.5, x: 0.25, y: 1 } },
  });
  assert.deepEqual(parseSettings("encuadre=entero", MAX_SOUND), { ok: true, settings: {} });
});

test("un encuadre no válido se explica", () => {
  for (const caption of [
    "encuadre=otro",
    "encuadre=recortar zoom=0.5",
    "encuadre=recortar zoom=5",
    "encuadre=recortar x=1.1",
    "encuadre=recortar y=abc",
    "zoom=2",
    "encuadre=entero x=0.5",
  ]) {
    assert.equal(parseSettings(caption, MAX_SOUND).ok, false, caption);
  }
});
