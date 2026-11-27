import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConnectionLink, parseTailscaleAddress } from "./enlace-conexion.js";

test("construye el enlace con la dirección codificada y el token en el fragmento", () => {
  assert.equal(
    buildConnectionLink("https://equipo.tail1234.ts.net", "abc123"),
    "conversorstickers://bot#u=https%3A%2F%2Fequipo.tail1234.ts.net&t=abc123",
  );
  assert.equal(
    buildConnectionLink("http://127.0.0.1:8787", "tok"),
    "conversorstickers://bot#u=http%3A%2F%2F127.0.0.1%3A8787&t=tok",
  );
});

test("lee Self.DNSName de tailscale y quita el punto final", () => {
  const json = JSON.stringify({ Self: { DNSName: "equipo.tail1234.ts.net." } });
  assert.equal(parseTailscaleAddress(json), "https://equipo.tail1234.ts.net");
});

test("devuelve undefined si el JSON de tailscale está vacío, roto o sin nombre", () => {
  for (const text of ["", "no es json", "{}", '{"Self":{}}', '{"Self":{"DNSName":""}}', '{"Self":{"DNSName":"."}}', "null"]) {
    assert.equal(parseTailscaleAddress(text), undefined, text);
  }
});

test("el registro nunca contiene el token del enlace", async () => {
  const { createLogger } = await import("./logger.js");
  const { printConnectionLink } = await import("./enlace-conexion.js");
  const lines: string[] = [];
  const log = createLogger("debug", { write: (line: string) => void lines.push(line) });
  const written: string[] = [];
  await printConnectionLink({
    token: "TOKEN-SECRETO-XYZ",
    port: 1,
    log,
    findTailscale: async () => undefined,
    write: (text) => void written.push(text),
  });
  assert.doesNotMatch(lines.join(""), /TOKEN-SECRETO-XYZ/);
  assert.match(written.join(""), /TOKEN-SECRETO-XYZ/);
  assert.match(written.join(""), /no lo compartas/);
});
