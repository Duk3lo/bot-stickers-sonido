import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { AuthenticationCreds, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { UnreadableSessionError } from "./auth-files.js";
import { logger } from "./logger.js";
import {
  LinkingUnavailableError,
  StateConflictError,
  WhatsAppSession,
  type SessionAuth,
  type SessionDeps,
} from "./whatsapp-session.js";

const START_MS = 1_800_000_000_000;
const LINKED = { me: { id: "x" }, account: {}, registered: false };
const FRESH = { registered: false };

class FakeSocket {
  readonly ev = new EventEmitter();
  readonly pairingRequests: string[] = [];
  ended = false;
  loggedOut = false;
  logoutFails = false;
  pairingFails = false;

  constructor(readonly creds: Record<string, unknown>) {}

  async requestPairingCode(phone: string): Promise<string> {
    this.pairingRequests.push(phone);
    this.creds["me"] = { id: "x" };
    if (this.pairingFails) {
      throw new Error("sin conexión");
    }
    return "ABCD1234";
  }

  async logout(): Promise<void> {
    if (this.logoutFails) {
      throw new Error("sin conexión");
    }
    this.loggedOut = true;
    this.close(401);
  }

  end(): void {
    this.ended = true;
    this.close(undefined);
  }

  update(update: Record<string, unknown>): void {
    this.ev.emit("connection.update", update);
  }

  close(statusCode: number | undefined): void {
    this.update({ connection: "close", lastDisconnect: { error: { output: { statusCode } } } });
  }

  /** What Baileys does on pair-success. */
  pair(): void {
    Object.assign(this.creds, LINKED);
    this.ev.emit("creds.update", {});
    this.update({ isNewLogin: true });
  }

  receive(timestampSeconds: number | undefined, type = "notify", ...ids: string[]): void {
    const messages = (ids.length > 0 ? ids : ["m"]).map((id) => ({
      key: { id },
      messageTimestamp: timestampSeconds,
    }));
    this.ev.emit("messages.upsert", { type, messages });
  }
}

/** Lets pending promise chains run; setImmediate is not mocked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function setUp(
  t: TestContext,
  stored: Record<string, unknown> = LINKED,
  pairingPhone?: string,
  singleVideo?: SessionDeps["singleVideo"],
) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START_MS });
  const { unreadable = false, ...initial } = stored;
  const disk = {
    creds: { ...initial },
    clears: 0,
    saves: 0,
    loadFails: false,
    unreadable: unreadable === true,
  };
  const sockets: FakeSocket[] = [];
  const handled: { message: WAMessage; signal: AbortSignal }[] = [];
  const shown: string[] = [];
  const session = new WhatsAppSession({
    loadAuth: async () => {
      if (disk.unreadable) {
        throw new UnreadableSessionError();
      }
      if (disk.loadFails) {
        throw new Error("EMFILE");
      }
      const creds = { ...disk.creds };
      return {
        state: { creds: creds as unknown as AuthenticationCreds },
        saveCreds: async () => {
          disk.saves += 1;
          disk.creds = { ...creds };
        },
      } as unknown as SessionAuth;
    },
    openSocket: (state) => {
      const socket = new FakeSocket(state.creds as unknown as Record<string, unknown>);
      sockets.push(socket);
      return socket as unknown as WASocket;
    },
    clearAuth: async () => {
      disk.clears += 1;
      disk.creds = { ...FRESH };
    },
    onMessage: async (_sock, message, signal) => {
      handled.push({ message, signal });
    },
    pairingPhone,
    singleVideo,
    showQr: (qr) => shown.push(qr),
    showPairingCode: (code) => shown.push(code),
    log: logger.child({}, { level: "silent" }),
  });
  await session.restore();
  session.resume();
  await settle();
  const last = (): FakeSocket => {
    const socket = sockets.at(-1);
    assert.ok(socket, "no hay ningún socket");
    return socket;
  };
  const tick = async (ms: number): Promise<void> => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { session, disk, sockets, handled, shown, last, tick };
}

async function open(socket: FakeSocket): Promise<void> {
  socket.update({ connection: "open" });
  await settle();
}

test("vinculado: conecta pero arranca en pausa", async (t) => {
  const { session, last } = await setUp(t);
  assert.deepEqual(session.status(), {
    version: 1, vinculacion: "vinculado", conexion: "conectando", activo: false, codigo: null, qr: null, aviso: null,
  });
  await open(last());
  assert.equal(session.status().conexion, "conectado");
  assert.equal(session.status().activo, false);
});

test("sin conexión no se puede activar", async (t) => {
  const { session } = await setUp(t);
  assert.throws(() => session.activate(), StateConflictError);
  assert.equal(session.status().activo, false);
});

test("en pausa ignora los mensajes; activo ignora lo anterior a la activación", async (t) => {
  const { session, last, handled } = await setUp(t);
  await open(last());
  const now = START_MS / 1000;
  last().receive(now);
  assert.equal(handled.length, 0);
  session.activate();
  last().receive(now - 31);
  last().receive(undefined);
  last().receive(now, "append");
  assert.equal(handled.length, 0);
  last().receive(now - 30);
  last().receive(now + 1);
  assert.equal(handled.length, 2);
});

test("pausar aborta el trabajo en curso, también si se vuelve a activar", async (t) => {
  const { session, last, handled } = await setUp(t);
  await open(last());
  session.activate();
  last().receive(START_MS / 1000);
  session.pause();
  session.activate();
  assert.equal(handled[0]?.signal.aborted, true);
});

test("un cierre pone en pausa y no se reactiva solo al reconectar", async (t) => {
  const { session, last, sockets, handled, tick, disk } = await setUp(t);
  await open(last());
  session.activate();
  last().receive(START_MS / 1000);
  last().close(408);
  await settle();
  assert.equal(handled[0]?.signal.aborted, true);
  assert.equal(session.status().activo, false);
  assert.equal(session.status().conexion, "desconectado");
  assert.match(session.status().aviso ?? "", /pausa/);
  await tick(5_000);
  assert.equal(sockets.length, 2);
  await open(last());
  assert.equal(session.status().activo, false);
  assert.match(session.status().aviso ?? "", /pausa/);
  assert.equal(disk.clears, 0);
});

test("la espera de reconexión crece de 5 s a 5 min y se reinicia al conectar", async (t) => {
  const { last, sockets, tick, disk } = await setUp(t);
  for (const seconds of [5, 10, 20, 40, 80, 160, 300, 300]) {
    const before = sockets.length;
    last().close(408);
    await tick(seconds * 1000 - 1);
    assert.equal(sockets.length, before, `antes de ${seconds} s`);
    await tick(1);
    assert.equal(sockets.length, before + 1, `a los ${seconds} s`);
  }
  await open(last());
  last().close(408);
  await tick(5_000);
  assert.equal(sockets.length, 10);
  assert.equal(disk.clears, 0);
});

test("restartRequired reconecta ya, pero no entra en bucle", async (t) => {
  const { last, sockets, tick } = await setUp(t);
  last().close(515);
  await settle();
  assert.equal(sockets.length, 2);
  last().close(515);
  await settle();
  assert.equal(sockets.length, 2);
  await tick(5_000);
  assert.equal(sockets.length, 3);
});

test("si otra sesión reemplaza a esta no insiste ni borra nada", async (t) => {
  const { session, last, sockets, tick, disk } = await setUp(t);
  await open(last());
  last().close(440);
  await tick(3_600_000);
  assert.equal(sockets.length, 1);
  assert.equal(disk.clears, 0);
  assert.equal(session.status().vinculacion, "vinculado");
  assert.match(session.status().aviso ?? "", /otra sesión/i);
});

test("loggedOut borra la sesión y deja el bot sin vincular", async (t) => {
  const { session, last, sockets, tick, disk } = await setUp(t);
  await open(last());
  session.activate();
  last().close(401);
  await tick(3_600_000);
  assert.equal(sockets.length, 1);
  assert.equal(disk.clears, 1);
  assert.equal(session.status().vinculacion, "sin-vincular");
  assert.equal(session.status().activo, false);
  assert.ok(session.status().aviso);
});

test("si no puede leer una sesión vinculada, reintenta sin abrir socket ni borrar", async (t) => {
  const { session, last, sockets, tick, disk } = await setUp(t);
  disk.creds = { ...FRESH };
  last().close(408);
  await tick(5_000);
  assert.equal(sockets.length, 1);
  disk.loadFails = true;
  await tick(10_000);
  assert.equal(sockets.length, 1);
  disk.loadFails = false;
  disk.creds = { ...LINKED };
  await tick(20_000);
  assert.equal(sockets.length, 2);
  assert.equal(disk.clears, 0);
  assert.equal(session.status().vinculacion, "vinculado");
});

test("si la sesión reaparece al pedir vincular, se trata como vinculada y no se borra", async (t) => {
  const { session, disk } = await setUp(t, FRESH, "34600111333");
  disk.creds = { ...LINKED };
  session.startLinking("qr");
  await settle();
  assert.equal(session.status().vinculacion, "vinculado");
  assert.throws(() => session.startLinking("codigo"), StateConflictError);
  assert.equal(disk.clears, 0);
});

test("sin vincular no abre conexión hasta que se solicite", async (t) => {
  const { session, sockets, tick, disk } = await setUp(t, FRESH, "34600111333");
  await tick(3_600_000);
  assert.equal(sockets.length, 0);
  assert.equal(disk.clears, 0);
  assert.equal(session.status().vinculacion, "sin-vincular");
});

test("al arrancar limpia los restos de una vinculación a medias", async (t) => {
  const { session, sockets, disk } = await setUp(t, { me: { id: "x" }, registered: true });
  assert.equal(disk.clears, 1);
  assert.equal(sockets.length, 0);
  assert.equal(session.status().vinculacion, "sin-vincular");
});

test("vincular con código lo pide una sola vez y solo cuando el socket está listo", async (t) => {
  const { session, last, shown } = await setUp(t, FRESH, "34600111333");
  assert.equal(session.startLinking("codigo").vinculacion, "vinculando");
  await settle();
  assert.deepEqual(last().pairingRequests, []);
  last().update({ qr: "ref-1" });
  last().update({ qr: "ref-2" });
  await settle();
  assert.deepEqual(last().pairingRequests, ["34600111333"]);
  assert.equal(session.status().codigo, "ABCD-1234");
  assert.equal(session.status().qr, null);
  assert.deepEqual(shown, ["ABCD1234"]);
});

test("el número que llega con la petición manda sobre PAIRING_PHONE", async (t) => {
  const { session, last } = await setUp(t, FRESH, "34600111333");
  session.startLinking("codigo", "34600999888");
  await settle();
  last().update({ qr: "ref-1" });
  await settle();
  assert.deepEqual(last().pairingRequests, ["34600999888"]);
});

test("sin PAIRING_PHONE se vincula con el número de la petición, y cambiarlo reinicia el intento", async (t) => {
  const { session, sockets, last } = await setUp(t, FRESH);
  session.startLinking("codigo", "34600999888");
  await settle();
  session.startLinking("codigo", "34600999888");
  await settle();
  assert.equal(sockets.length, 1);
  session.startLinking("codigo", "34600999777");
  await settle();
  assert.equal(sockets.length, 2);
  last().update({ qr: "ref-1" });
  await settle();
  assert.deepEqual(last().pairingRequests, ["34600999777"]);
});

test("vincular con QR expone el último y, tras emparejar, reconecta ya", async (t) => {
  const { session, last, sockets, disk, shown } = await setUp(t, FRESH);
  session.startLinking("qr");
  await settle();
  last().update({ qr: "ref-1" });
  last().update({ qr: "ref-2" });
  assert.equal(session.status().qr, "ref-2");
  assert.deepEqual(shown, ["ref-1", "ref-2"]);
  last().pair();
  assert.equal(session.status().vinculacion, "vinculado");
  assert.equal(session.status().qr, null);
  last().close(515);
  await settle();
  assert.equal(sockets.length, 2);
  assert.equal(disk.saves, 1);
  assert.equal(disk.clears, 0);
  await open(last());
  assert.equal(session.status().conexion, "conectado");
  assert.equal(session.status().activo, false);
});

test("un intento caducado se limpia, no se repite solo y permite reintentar", async (t) => {
  const { session, last, sockets, tick, disk } = await setUp(t, FRESH, "34600111333");
  session.startLinking("codigo");
  await settle();
  last().update({ qr: "ref" });
  await settle();
  last().close(408);
  await tick(3_600_000);
  assert.equal(sockets.length, 1);
  assert.equal(disk.clears, 1);
  assert.equal(session.status().vinculacion, "sin-vincular");
  assert.equal(session.status().codigo, null);
  assert.match(session.status().aviso ?? "", /vinculación/);
  session.startLinking("codigo");
  await settle();
  assert.equal(sockets.length, 2);
});

test("si falla la petición del código, abandona el intento", async (t) => {
  const { session, last, disk } = await setUp(t, FRESH, "34600111333");
  session.startLinking("codigo");
  await settle();
  last().pairingFails = true;
  last().update({ qr: "ref" });
  await settle();
  assert.equal(last().ended, true);
  assert.equal(disk.clears, 1);
  assert.equal(session.status().vinculacion, "sin-vincular");
  assert.match(session.status().aviso ?? "", /código/);
});

test("repetir la solicitud no abre otro socket; cambiar de método reinicia el intento", async (t) => {
  const { session, last, sockets, disk } = await setUp(t, FRESH, "34600111333");
  session.startLinking("qr");
  await settle();
  session.startLinking("qr");
  await settle();
  assert.equal(sockets.length, 1);
  const first = last();
  session.startLinking("codigo");
  await settle();
  assert.equal(first.ended, true);
  assert.equal(sockets.length, 2);
  assert.equal(disk.clears, 1);
  assert.equal(session.status().vinculacion, "vinculando");
});

test("no se puede vincular si ya está vinculado ni con código sin PAIRING_PHONE", async (t) => {
  const linked = await setUp(t);
  assert.throws(() => linked.session.startLinking("qr"), StateConflictError);
  t.mock.timers.reset();
  const fresh = await setUp(t, FRESH);
  assert.throws(() => fresh.session.startLinking("codigo"), LinkingUnavailableError);
  assert.equal(fresh.sockets.length, 0);
});

test("desvincular cierra sesión en WhatsApp y borra las credenciales", async (t) => {
  const { session, last, sockets, tick, disk } = await setUp(t);
  await assert.rejects(session.unlink(), StateConflictError);
  await open(last());
  session.activate();
  const status = await session.unlink();
  await tick(3_600_000);
  assert.equal(last().loggedOut, true);
  assert.equal(disk.clears, 1);
  assert.equal(sockets.length, 1);
  assert.equal(status.vinculacion, "sin-vincular");
  assert.equal(status.activo, false);
  assert.equal(status.aviso, null);
});

test("si no puede avisar a WhatsApp, desvincular falla y conserva la sesión", async (t) => {
  const { session, last, disk } = await setUp(t);
  await open(last());
  last().logoutFails = true;
  await assert.rejects(session.unlink(), StateConflictError);
  assert.equal(disk.clears, 0);
  assert.equal(session.status().vinculacion, "vinculado");
});

const isVideo: SessionDeps["singleVideo"] = (_sock, message) => message.key.id?.startsWith("video") === true;

async function setUpSingleVideo(t: TestContext) {
  const context = await setUp(t, LINKED, undefined, isVideo);
  await open(context.last());
  context.session.activate();
  return context;
}

test("chat propio: dos videos seguidos solo producen un procesamiento y el bot se pausa", async (t) => {
  const { session, last, handled } = await setUpSingleVideo(t);
  last().receive(START_MS / 1000, "notify", "video-1", "video-2");
  last().receive(START_MS / 1000, "notify", "video-3");
  assert.deepEqual(handled.map(({ message }) => message.key.id), ["video-1"]);
  assert.equal(session.status().activo, false);
  assert.match(session.status().aviso ?? "", /pausó/);
  // The automatic pause must still let the result be sent.
  assert.equal(handled[0]?.signal.aborted, false);
});

test("chat propio: lo que no es un video aceptado no gasta la activación", async (t) => {
  const { session, last, handled } = await setUpSingleVideo(t);
  last().receive(START_MS / 1000, "notify", "texto");
  last().receive(START_MS / 1000 - 31, "notify", "video-viejo");
  last().receive(START_MS / 1000, "append", "video-propio-del-bot");
  assert.equal(handled.length, 0);
  assert.equal(session.status().activo, true);
});

test("chat propio: una pausa manual cancela el video en curso, aunque ya esté en pausa", async (t) => {
  const { session, last, handled } = await setUpSingleVideo(t);
  last().receive(START_MS / 1000, "notify", "video-1");
  session.pause();
  assert.equal(handled[0]?.signal.aborted, true);
});

test("chat propio: una desconexión cancela el video en curso", async (t) => {
  const { last, handled } = await setUpSingleVideo(t);
  last().receive(START_MS / 1000, "notify", "video-1");
  last().close(408);
  assert.equal(handled[0]?.signal.aborted, true);
});

test("con creds.json ilegible avisa, rechaza vincular y no borra nada", async (t) => {
  const { session, sockets, disk, tick } = await setUp(t, { unreadable: true }, "34600111333");
  await tick(3_600_000);
  assert.equal(session.status().vinculacion, "sin-vincular");
  assert.match(session.status().aviso ?? "", /creds\.json/);
  for (const method of ["qr", "codigo"] as const) {
    assert.throws(() => session.startLinking(method), StateConflictError);
  }
  assert.equal(sockets.length, 0);
  assert.equal(disk.clears, 0);
});

test("si creds.json se vuelve ilegible al pedir vincular, no borra nada", async (t) => {
  const { session, sockets, disk } = await setUp(t, FRESH, "34600111333");
  disk.unreadable = true;
  session.startLinking("qr");
  session.startLinking("codigo");
  await settle();
  assert.equal(sockets.length, 0);
  assert.equal(disk.clears, 0);
  assert.equal(session.status().vinculacion, "sin-vincular");
  assert.match(session.status().aviso ?? "", /creds\.json/);
  assert.throws(() => session.startLinking("qr"), StateConflictError);
});

test("una sesión vinculada que se vuelve ilegible se reintenta sin borrar", async (t) => {
  const { session, last, sockets, tick, disk } = await setUp(t);
  disk.unreadable = true;
  last().close(408);
  await tick(5_000);
  assert.equal(sockets.length, 1);
  assert.equal(disk.clears, 0);
  assert.equal(session.status().vinculacion, "vinculado");
  assert.match(session.status().aviso ?? "", /creds\.json/);
});
