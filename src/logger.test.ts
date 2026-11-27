import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, redact } from "./logger.js";

test("quita JID y secuencias largas de dígitos", () => {
  assert.equal(redact("de 34600111222:12@s.whatsapp.net ya"), "de [oculto] ya");
  assert.equal(redact("lid 123456789012345@lid y 1203630-1600@g.us"), "lid [oculto] y [oculto]");
  assert.equal(redact("número 34600111222."), "número [oculto].");
  assert.equal(redact("error 515 en 2026-11-26T10:00:00.123Z"), "error 515 en 2026-11-26T10:00:00.123Z");
});

test("sanea mensajes, claves, errores anidados e hijos del registro", () => {
  const lines: string[] = [];
  const log = createLogger("info", { write: (line: string) => void lines.push(line) });
  const error = Object.assign(new Error("fallo con 34600111222@s.whatsapp.net"), {
    data: { attrs: { from: "34600111333@s.whatsapp.net" }, content: Buffer.from("secreto") },
  });
  log.child({ module: "baileys" }).error(
    { err: error, "34600111444@lid": true, pushName: "Persona", qr: "texto-qr", pairingCode: "ABCD1234" },
    "no pude responder a 34600111555",
  );
  const output = lines.join("");
  assert.doesNotMatch(output, /34600111|Persona|texto-qr|ABCD1234|"data":\[/);
  assert.match(output, /no pude responder/);
  assert.equal(JSON.parse(output).module, "baileys");
});

test("oculta el XML de Baileys y los nombres dentro de cadenas", () => {
  const lines: string[] = [];
  const log = createLogger("info", { write: (line: string) => void lines.push(line) });
  log.error({ node: "<message notify='Nombre Uno'/>" }, "error in handling message");
  log.error(
    { detail: "<message id='a' notify='Ana O'Nombre' verified_name=\"Tienda Dos\" t='1'/>" },
    "fallo en <receipt notify='Nombre Tres'>",
  );
  const output = lines.join("");
  assert.doesNotMatch(output, /Nombre|Tienda|Ana/);
  assert.match(output, /message id='a'/);
  assert.match(output, /t='1'/);
});

test("oculta el número que Baileys mete en el error de requestPairingCode", () => {
  const lines: string[] = [];
  const log = createLogger("info", { write: (line: string) => void lines.push(line) });
  log.error({ err: new Error("Connection Closed para 34600111222") }, "No pude pedir el código de vinculación.");
  assert.doesNotMatch(lines.join(""), /34600111222/);
});
