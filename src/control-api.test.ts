import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createControlServer, startControlServer, type SessionControl } from "./control-api.js";
import { logger } from "./logger.js";
import { LinkingUnavailableError, StateConflictError, type SessionStatus } from "./whatsapp-session.js";

const TOKEN = "t".repeat(43);
const STATUS: SessionStatus = {
  version: 1, vinculacion: "vinculado", conexion: "conectado", activo: false, codigo: null, qr: null, aviso: null,
};

interface Reply {
  readonly status: number;
  readonly cache: string | undefined;
  readonly body: unknown;
}

async function setUp(t: TestContext, overrides: Partial<SessionControl> = {}) {
  const calls: string[] = [];
  const record = (name: string) => (): SessionStatus => {
    calls.push(name);
    return STATUS;
  };
  const session: SessionControl = {
    status: record("status"),
    activate: record("activate"),
    pause: record("pause"),
    startLinking: (method) => record(`link:${method}`)(),
    unlink: async () => record("unlink")(),
    ...overrides,
  };
  const server = createControlServer({ session, token: TOKEN, log: logger.child({}, { level: "silent" }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;

  const send = (
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const headers = { authorization: `Bearer ${TOKEN}`, ...options.headers };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, cache: res.headers["cache-control"], body: JSON.parse(text) }),
        );
      });
      req.on("error", reject);
      req.end(options.body);
    });
  return { send, calls };
}

test("cada operación responde con el estado y su código", async (t) => {
  const { send, calls } = await setUp(t);
  for (const [method, path, status, body] of [
    ["GET", "/estado", 200, undefined],
    ["POST", "/activar", 200, undefined],
    ["POST", "/pausar", 200, undefined],
    ["POST", "/vinculacion", 202, '{"metodo":"codigo"}'],
    ["POST", "/vinculacion", 202, '{"metodo":"qr"}'],
    ["DELETE", "/vinculacion", 200, undefined],
  ] as const) {
    const reply = await send(method, path, body === undefined ? {} : { body });
    assert.deepEqual(reply, { status, cache: "no-store", body: STATUS }, `${method} ${path}`);
  }
  assert.deepEqual(calls, ["status", "activate", "pause", "link:codigo", "link:qr", "unlink"]);
});

function assertError(reply: Reply, status: number): void {
  assert.equal(reply.status, status);
  assert.equal(reply.cache, "no-store");
  assert.equal(typeof (reply.body as { error: unknown }).error, "string");
}

test("sin token o con uno erróneo responde 401", async (t) => {
  const { send, calls } = await setUp(t);
  for (const authorization of ["", "Bearer nada", `Bearer ${TOKEN}x`, TOKEN]) {
    assertError(await send("GET", "/estado", { headers: { authorization } }), 401);
  }
  assert.deepEqual(calls, []);
});

test("tras 10 fallos en un minuto los fallos responden 429, pero el token correcto se atiende", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { send } = await setUp(t);
  for (let i = 0; i < 10; i += 1) {
    assertError(await send("GET", "/estado", { headers: { authorization: "Bearer no" } }), 401);
  }
  assertError(await send("GET", "/estado", { headers: { authorization: "Bearer no" } }), 429);
  // The right token is always served: failed attempts must never keep the owner from pausing.
  assert.equal((await send("POST", "/pausar")).status, 200);
  assertError(await send("GET", "/estado", { headers: { authorization: "Bearer no" } }), 429);
  t.mock.timers.tick(60_001);
  assertError(await send("GET", "/estado", { headers: { authorization: "Bearer no" } }), 401);
});

test("solo admite Host local o de Tailscale", async (t) => {
  const { send } = await setUp(t);
  for (const host of ["127.0.0.1:8787", "localhost", "equipo.cola-pez.ts.net", "equipo.cola-pez.ts.net:443"]) {
    assert.equal((await send("GET", "/estado", { headers: { host } })).status, 200, host);
  }
  for (const host of ["evil.com", "ts.net", "equipo.ts.net.evil.com", "127.0.0.1.evil.com", "192.168.1.2"]) {
    assertError(await send("GET", "/estado", { headers: { host } }), 403);
  }
});

test("rechaza cualquier petición con Origin", async (t) => {
  const { send, calls } = await setUp(t);
  for (const origin of ["http://localhost", "null"]) {
    assertError(await send("POST", "/activar", { headers: { origin } }), 403);
  }
  assert.deepEqual(calls, []);
});

test("rechaza cuerpos de más de 1 KiB", async (t) => {
  const { send, calls } = await setUp(t);
  const body = JSON.stringify({ metodo: "qr", relleno: "a".repeat(1100) });
  assertError(await send("POST", "/vinculacion", { body }), 413);
  assertError(await send("POST", "/activar", { body }), 413);
  assert.deepEqual(calls, []);
});

test("un método de vinculación no válido responde 422", async (t) => {
  const { send, calls } = await setUp(t);
  for (const body of ["", "no es json", "null", "{}", '{"metodo":"sms"}']) {
    assertError(await send("POST", "/vinculacion", { body }), 422);
  }
  assert.deepEqual(calls, []);
});

test("traduce los errores del bot a 409, 422 y 500", async (t) => {
  const { send } = await setUp(t, {
    activate: () => {
      throw new StateConflictError("No hay conexión con WhatsApp.");
    },
    startLinking: () => {
      throw new LinkingUnavailableError("Falta PAIRING_PHONE.");
    },
    unlink: async () => {
      throw new Error("detalle interno");
    },
  });
  assert.deepEqual((await send("POST", "/activar")).body, { error: "No hay conexión con WhatsApp." });
  assertError(await send("POST", "/activar"), 409);
  assertError(await send("POST", "/vinculacion", { body: '{"metodo":"codigo"}' }), 422);
  const reply = await send("DELETE", "/vinculacion");
  assertError(reply, 500);
  assert.doesNotMatch(JSON.stringify(reply.body), /detalle/);
});

test("una ruta o un verbo desconocidos responden 404", async (t) => {
  const { send } = await setUp(t);
  assertError(await send("GET", "/otra"), 404);
  assertError(await send("GET", "/activar"), 404);
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function fakeSession(): SessionControl {
  return {
    status: () => STATUS,
    activate: () => STATUS,
    pause: () => STATUS,
    startLinking: () => STATUS,
    unlink: async () => STATUS,
  };
}

const SILENT = logger.child({}, { level: "silent" });

test("con el puerto ocupado falla sin llegar a leer la sesión", async (t) => {
  const other = createServer();
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  t.after(() => other.close());
  let restored = false;
  await assert.rejects(
    startControlServer({
      session: fakeSession(),
      token: TOKEN,
      log: SILENT,
      port: (other.address() as AddressInfo).port,
      restore: async () => {
        restored = true;
      },
    }),
    { code: "EADDRINUSE" },
  );
  assert.equal(restored, false);
});

test("no atiende peticiones hasta que se haya leído la sesión", async (t) => {
  const port = await freePort();
  const events: string[] = [];
  let finishRestore = (): void => {};
  let restoring = (): void => {};
  const restoreStarted = new Promise<void>((resolve) => (restoring = resolve));
  const started = startControlServer({
    session: { ...fakeSession(), status: () => (events.push("served"), STATUS) },
    token: TOKEN,
    log: SILENT,
    port,
    restore: () => {
      restoring();
      return new Promise<void>((resolve) => (finishRestore = resolve));
    },
  });
  await restoreStarted;
  const reply = fetch(`http://127.0.0.1:${port}/estado`, { headers: { authorization: `Bearer ${TOKEN}` } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  events.push("restored");
  finishRestore();
  const server = await started;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  assert.equal((await reply).status, 200);
  assert.deepEqual(events, ["restored", "served"]);
});
