import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedHost, isAllowedOrigin } from "./red-local.js";

test("admite origen loopback, privado y Tailscale, también mapeado a IPv6", () => {
  for (const address of [
    "127.0.0.1", "::1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.50",
    "100.64.0.1", "100.127.255.255", "::ffff:192.168.1.50", "::ffff:127.0.0.1", "::FFFF:10.0.0.2",
  ]) {
    assert.equal(isAllowedOrigin(address), true, address);
  }
});

test("rechaza cualquier otro origen", () => {
  for (const address of [
    "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "11.0.0.1",
    "::ffff:8.8.8.8", "2001:db8::1", "fe80::1", "999.1.1.1", "10.0.0", "no-es-ip", "", undefined,
  ]) {
    assert.equal(isAllowedOrigin(address), false, String(address));
  }
});

test("el Host admite nombres locales, ts.net y una IPv4 privada con puerto", () => {
  for (const host of [
    "127.0.0.1:8787", "localhost", "equipo.cola-pez.ts.net:443", "192.168.1.50:8787", "10.0.0.5:9000", "172.20.1.1:1",
  ]) {
    assert.equal(isAllowedHost(host), true, host);
  }
});

test("el Host rechaza IPs públicas, IPv4 sin puerto y nombres ajenos", () => {
  for (const host of [
    "192.168.1.50", "8.8.8.8:8787", "192.168.1.50.evil.com:8787", "evil.com", "ts.net", "172.32.0.1:8787", "", "300.1.1.1:80",
  ]) {
    assert.equal(isAllowedHost(host), false, host);
  }
});
