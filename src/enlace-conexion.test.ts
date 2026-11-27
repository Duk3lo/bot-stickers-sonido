import { test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import {
  buildConnectionLink,
  chooseAddresses,
  chooseLanAddresses,
  firewallCommand,
  parseTailscaleAddress,
} from "./enlace-conexion.js";

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
    listenOnNetwork: true,
    interfaces: () => ({}),
    log,
    findTailscale: async () => undefined,
    write: (text) => void written.push(text),
  });
  assert.doesNotMatch(lines.join(""), /TOKEN-SECRETO-XYZ/);
  assert.match(written.join(""), /TOKEN-SECRETO-XYZ/);
  assert.match(written.join(""), /no lo compartas/);
});

function nic(address: string, internal = false, family: "IPv4" | "IPv6" = "IPv4"): NetworkInterfaceInfo {
  return { address, family, internal, netmask: "", mac: "", cidr: null } as NetworkInterfaceInfo;
}

test("elige IPv4 privadas e ignora internas, docker, veth, br-, públicas e IPv6; prefiere Wi-Fi y Ethernet", () => {
  const addresses = chooseLanAddresses({
    lo: [nic("127.0.0.1", true)],
    docker0: [nic("172.17.0.1")],
    veth1a: [nic("172.18.0.1")],
    "br-abc": [nic("172.19.0.1")],
    tun0: [nic("10.8.0.2")],
    wlan0: [nic("fe80::1", false, "IPv6"), nic("192.168.1.50")],
    enp3s0: [nic("192.168.1.20")],
    wwan0: [nic("8.8.8.8")],
  });
  assert.deepEqual(addresses, ["192.168.1.20", "192.168.1.50", "10.8.0.2"]);
});

test("sin interfaces válidas devuelve una lista vacía", () => {
  assert.deepEqual(chooseLanAddresses({ lo: [nic("127.0.0.1", true)], docker0: [nic("172.17.0.1")] }), []);
});

test("ofrece LAN, luego Tailscale y 127.0.0.1 solo si no hay nada más", () => {
  assert.deepEqual(chooseAddresses(["192.168.1.5", "10.0.0.2"], 8787, "https://e.ts.net"), [
    "http://192.168.1.5:8787",
    "http://10.0.0.2:8787",
    "https://e.ts.net",
  ]);
  assert.deepEqual(chooseAddresses([], 8787, "https://e.ts.net"), ["https://e.ts.net"]);
  assert.deepEqual(chooseAddresses([], 9000, undefined), ["http://127.0.0.1:9000"]);
});

test("el comando de ufw se limita a la red local de la dirección", () => {
  assert.equal(firewallCommand("192.168.1.50", 8787), "sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp");
});

test("imprime enlace y QR solo para la primera dirección; las demás como texto, y el aviso de Wi-Fi", async () => {
  const { createLogger } = await import("./logger.js");
  const { printConnectionLink } = await import("./enlace-conexion.js");
  const written: string[] = [];
  await printConnectionLink({
    token: "TOK",
    port: 8787,
    listenOnNetwork: true,
    log: createLogger("debug", { write: () => {} }),
    findTailscale: async () => "https://e.ts.net",
    interfaces: () => ({ wlan0: [nic("192.168.1.50")], eth0: [nic("10.0.0.2")] }),
    write: (text) => void written.push(text),
  });
  const output = written.join("");
  assert.match(output, /\nconversorstickers:\/\/bot#u=http%3A%2F%2F10\.0\.0\.2%3A8787&t=TOK\n/);
  assert.match(output, /http%3A%2F%2F192\.168\.1\.50%3A8787&t=TOK/);
  assert.match(output, /https%3A%2F%2Fe\.ts\.net&t=TOK/);
  assert.match(output, /misma Wi-Fi/);
  assert.match(output, /sudo ufw allow from 10\.0\.0\.0\/24 to any port 8787 proto tcp/);
  assert.match(output, /tailscale serve --bg 8787/);
});

test("con ESCUCHAR_EN_RED=no no ofrece direcciones de la red local", async () => {
  const { createLogger } = await import("./logger.js");
  const { printConnectionLink } = await import("./enlace-conexion.js");
  const written: string[] = [];
  await printConnectionLink({
    token: "TOK",
    port: 8787,
    listenOnNetwork: false,
    log: createLogger("debug", { write: () => {} }),
    findTailscale: async () => undefined,
    interfaces: () => ({ wlan0: [nic("192.168.1.50")] }),
    write: (text) => void written.push(text),
  });
  const output = written.join("");
  assert.match(output, /127\.0\.0\.1/);
  assert.doesNotMatch(output, /192\.168|Wi-Fi/);
});
