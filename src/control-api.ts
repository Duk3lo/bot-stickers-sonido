import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "./logger.js";
import {
  LinkingUnavailableError,
  StateConflictError,
  type LinkMethod,
  type WhatsAppSession,
} from "./whatsapp-session.js";

const CONTROL_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1024;
const MAX_FAILED_LOGINS = 10;
const FAILED_LOGIN_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Local names, or the one `tailscale serve` forwards. Anything else suggests DNS rebinding. */
const ALLOWED_HOST = /^(127\.0\.0\.1|localhost|([a-z0-9-]+\.)+ts\.net)(:\d{1,5})?$/i;

export type SessionControl = Pick<WhatsAppSession, "status" | "activate" | "pause" | "startLinking" | "unlink">;

export interface ControlServerDeps {
  readonly session: SessionControl;
  readonly token: string;
  readonly log: Logger;
  /** Authorized requests wait for this before touching the session. */
  readonly ready?: Promise<void>;
}

export interface ControlServerStart extends Omit<ControlServerDeps, "ready"> {
  readonly port: number;
  /** Reads the stored session. Runs only once the port is ours. */
  restore(): Promise<void>;
}

/**
 * Takes the port before reading the session: a second instance fails here without touching AUTH_DIR.
 */
export async function startControlServer({ port, restore, ...deps }: ControlServerStart): Promise<Server> {
  let markReady = (): void => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  const server = createControlServer({ ...deps, ready });
  server.listen(port, CONTROL_HOST);
  await once(server, "listening");
  try {
    await restore();
  } catch (error) {
    server.closeAllConnections();
    server.close();
    throw error;
  }
  markReady();
  return server;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

interface ApiReply {
  readonly status: number;
  readonly body: unknown;
}

function digest(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** HTTP control API, without listening yet. */
export function createControlServer({ session, token, log, ready }: ControlServerDeps): Server {
  const expected = digest(`Bearer ${token}`);
  let failedLogins: number[] = [];

  function authorize(request: IncomingMessage): void {
    if (!ALLOWED_HOST.test(request.headers.host ?? "")) {
      throw new RequestError(403, "Host no permitido.");
    }
    // Only browsers send Origin, and no web page may drive the bot.
    if (request.headers.origin !== undefined) {
      throw new RequestError(403, "No se admiten peticiones desde un navegador.");
    }
    // Hashing first gives equal lengths, which timingSafeEqual requires.
    // The right token is always served, so failures can never keep the owner from pausing the bot.
    if (timingSafeEqual(digest(request.headers.authorization ?? ""), expected)) {
      return;
    }
    const now = Date.now();
    failedLogins = failedLogins.filter((at) => now - at < FAILED_LOGIN_WINDOW_MS);
    if (failedLogins.length >= MAX_FAILED_LOGINS) {
      throw new RequestError(429, "Demasiados intentos fallidos. Espera un minuto.");
    }
    failedLogins.push(now);
    throw new RequestError(401, "Token no válido.");
  }

  async function route(request: IncomingMessage): Promise<ApiReply> {
    authorize(request);
    await ready;
    const body = await readBody(request);
    switch (`${request.method} ${request.url}`) {
      case "GET /estado":
        return { status: 200, body: session.status() };
      case "POST /activar":
        return { status: 200, body: session.activate() };
      case "POST /pausar":
        return { status: 200, body: session.pause() };
      case "POST /vinculacion":
        return { status: 202, body: session.startLinking(parseLinkMethod(body)) };
      case "DELETE /vinculacion":
        return { status: 200, body: await session.unlink() };
      default:
        throw new RequestError(404, "Ruta no encontrada.");
    }
  }

  function errorReply(error: unknown): ApiReply {
    if (error instanceof RequestError) {
      return { status: error.status, body: { error: error.message } };
    }
    if (error instanceof StateConflictError) {
      return { status: 409, body: { error: error.message } };
    }
    if (error instanceof LinkingUnavailableError) {
      return { status: 422, body: { error: error.message } };
    }
    log.error({ err: error }, "Error inesperado en la API de control.");
    return { status: 500, body: { error: "Error interno del bot." } };
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void route(request)
      .catch(errorReply)
      .then(({ status, body }) => {
        response.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(body));
      });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

/** Reads the whole body; an oversized one is drained but not kept, so the reply still arrives. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) {
      chunks.push(chunk);
    }
  }
  if (size > MAX_BODY_BYTES) {
    throw new RequestError(413, "El cuerpo de la petición es demasiado grande.");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseLinkMethod(body: string): LinkMethod {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
  const method = typeof parsed === "object" && parsed !== null && "metodo" in parsed ? parsed.metodo : undefined;
  if (method !== "codigo" && method !== "qr") {
    throw new RequestError(422, 'Método no válido: envía {"metodo":"codigo"} o {"metodo":"qr"}.');
  }
  return method;
}
