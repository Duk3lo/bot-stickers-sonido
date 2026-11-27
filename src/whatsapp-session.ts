import {
  DisconnectReason,
  type AuthenticationCreds,
  type AuthenticationState,
  type ConnectionState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { UnreadableSessionError } from "./auth-files.js";
import type { Logger } from "./logger.js";
import { formatPairingCode } from "./vinculacion.js";

const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60 * 1000;
/** Clock differences between the phone and this machine must not drop a message sent just after activating. */
const ACTIVATION_TOLERANCE_MS = 30_000;

const NOTICE_LOST = "Se perdió la conexión con WhatsApp; el bot está en pausa. Reintentando…";
const NOTICE_STILL_PAUSED = "Se perdió la conexión y se recuperó: el bot sigue en pausa hasta que lo actives.";
const NOTICE_REPLACED = "Otra sesión ha reemplazado a esta. Reinicia el bot para volver a conectar.";
const NOTICE_LOGGED_OUT = "WhatsApp cerró la sesión. Vuelve a vincular el bot.";
const NOTICE_LINKING_INCOMPLETE = "La vinculación caducó o no se completó. Vuelve a solicitarla.";
const NOTICE_CODE_FAILED = "No pude pedir el código de vinculación. Inténtalo de nuevo.";
const NOTICE_UNREADABLE = "No pude leer la sesión guardada (creds.json en AUTH_DIR). No he borrado nada. Reintentando…";
const NOTICE_DAMAGED =
  "No puedo leer creds.json en AUTH_DIR (permisos o archivo dañado). No he borrado nada: " +
  "corrígelo o muévelo a otra carpeta y reinicia el bot.";
const NOTICE_SINGLE_VIDEO =
  "Modo de chat propio: el bot se pausó solo tras recibir un video. Actívalo de nuevo para procesar otro.";
const NOTICE_NOT_CLEARED = "No pude borrar los archivos de la sesión en AUTH_DIR.";

export type LinkMethod = "codigo" | "qr";

/** The state returned by the control API (version 1 of the contract). */
export interface SessionStatus {
  readonly version: 1;
  readonly vinculacion: "sin-vincular" | "vinculando" | "vinculado";
  readonly conexion: "desconectado" | "conectando" | "conectado";
  readonly activo: boolean;
  readonly codigo: string | null;
  readonly qr: string | null;
  readonly aviso: string | null;
}

/** The requested operation does not fit the current state. */
export class StateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateConflictError";
  }
}

/** The configuration does not allow the requested way of linking. */
export class LinkingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkingUnavailableError";
  }
}

export interface SessionAuth {
  readonly state: AuthenticationState;
  saveCreds(): Promise<void>;
}

export interface SessionDeps {
  loadAuth(): Promise<SessionAuth>;
  openSocket(state: AuthenticationState): WASocket;
  clearAuth(): Promise<void>;
  /** Called only while active; `signal` aborts on a manual pause or a disconnection. */
  onMessage(sock: WASocket, message: WAMessage, signal: AbortSignal): Promise<void>;
  /** Own chat mode: only messages it accepts are processed, and the first one pauses the bot. */
  readonly singleVideo: ((sock: WASocket, message: WAMessage) => boolean) | undefined;
  readonly pairingPhone: string | undefined;
  showQr(qr: string): void;
  showPairingCode(code: string): void;
  readonly log: Logger;
}

/**
 * `creds.account` only exists after WhatsApp confirms the pairing. `creds.me` is already filled by
 * requestPairingCode, and `creds.registered` stays false when linking by QR.
 */
function isLinked(creds: AuthenticationCreds): boolean {
  return creds.account !== undefined && creds.account !== null && creds.me?.id !== undefined;
}

/** What an interrupted linking attempt leaves behind. */
function isHalfLinked(creds: AuthenticationCreds): boolean {
  return !isLinked(creds) && (creds.me !== undefined || creds.registered);
}

/**
 * Owns the WhatsApp connection: linking, reconnection and whether the bot is active. The bot starts
 * paused, every disconnection pauses it and only an explicit request activates it.
 */
export class WhatsAppSession {
  private linking: SessionStatus["vinculacion"] = "sin-vincular";
  private connection: SessionStatus["conexion"] = "desconectado";
  private linkMethod: LinkMethod = "qr";
  private pairingCodeRequested = false;
  /** The number the current code attempt is for. */
  private linkPhone: string | undefined;
  private code: string | null = null;
  private qr: string | null = null;
  private notice: string | null = null;
  private activeSince: number | undefined;
  /** Aborted by a manual pause or a disconnection, so jobs already started send nothing more. */
  private jobs = new AbortController();
  private socket: WASocket | undefined;
  /** Changes whenever the current socket is dropped, so its late events are ignored. */
  private generation = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private retries = 0;
  private restartedWithoutOpening = false;
  private pausedByDisconnection = false;
  private unlinking = false;
  /** A stored session we cannot read: linking would overwrite it, so it is refused until a restart. */
  private damagedSession = false;
  /** Saves and deletions of the session files run one after another. */
  private authWrites: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionDeps) {}

  /** Reads the stored session. Opens no connection. */
  async restore(): Promise<void> {
    let auth: SessionAuth;
    try {
      auth = await this.deps.loadAuth();
    } catch (error) {
      if (!(error instanceof UnreadableSessionError)) {
        throw error;
      }
      this.refuseLinking(error);
      return;
    }
    const { state } = auth;
    if (isLinked(state.creds)) {
      this.linking = "vinculado";
    } else if (isHalfLinked(state.creds)) {
      await this.forgetAuth();
    }
  }

  /** Connects if there is a linked session; otherwise waits for a linking request. */
  resume(): void {
    if (this.linking === "vinculado") {
      void this.connect();
    }
  }

  status(): SessionStatus {
    return {
      version: 1,
      vinculacion: this.linking,
      conexion: this.connection,
      activo: this.activeSince !== undefined,
      codigo: this.code,
      qr: this.qr,
      aviso: this.notice,
    };
  }

  activate(): SessionStatus {
    if (this.connection !== "conectado" || this.linking !== "vinculado" || this.unlinking) {
      throw new StateConflictError("No hay conexión con WhatsApp: no se puede activar el bot.");
    }
    this.activeSince ??= Date.now();
    this.notice = null;
    this.pausedByDisconnection = false;
    return this.status();
  }

  pause(): SessionStatus {
    this.activeSince = undefined;
    this.jobs.abort();
    this.jobs = new AbortController();
    return this.status();
  }

  /** `phone` is only used to link by code; without it, the configured pairing number is used. */
  startLinking(method: LinkMethod, phone?: string): SessionStatus {
    if (this.linking === "vinculado") {
      throw new StateConflictError("El bot ya está vinculado.");
    }
    if (this.damagedSession) {
      throw new StateConflictError(NOTICE_DAMAGED);
    }
    const linkPhone = method === "codigo" ? (phone ?? this.deps.pairingPhone) : undefined;
    if (method === "codigo" && linkPhone === undefined) {
      throw new LinkingUnavailableError(
        "Falta el número: escríbelo en la app, pon PAIRING_PHONE en el .env del bot o vincula con QR.",
      );
    }
    if (this.linking === "vinculando") {
      if (method === this.linkMethod && linkPhone === this.linkPhone) {
        return this.status();
      }
      void this.abandonLinking(null);
    }
    this.linking = "vinculando";
    this.linkMethod = method;
    this.linkPhone = linkPhone;
    this.pairingCodeRequested = false;
    this.notice = null;
    void this.connect();
    return this.status();
  }

  async unlink(): Promise<SessionStatus> {
    const socket = this.socket;
    if (this.linking !== "vinculado" || this.connection !== "conectado" || !socket || this.unlinking) {
      throw new StateConflictError("Para desvincular, el bot tiene que estar vinculado y conectado a WhatsApp.");
    }
    this.pause();
    this.unlinking = true;
    try {
      await socket.logout();
    } catch (error) {
      this.deps.log.warn({ err: error }, "No pude desvincular.");
      throw new StateConflictError("No pude avisar a WhatsApp para desvincular. Inténtalo de nuevo.");
    } finally {
      this.unlinking = false;
    }
    this.dropSocket();
    this.linking = "sin-vincular";
    this.notice = null;
    await this.forgetAuth();
    return this.status();
  }

  /** Pauses and forgets the current socket and any pending reconnection. */
  private dropSocket(): WASocket | undefined {
    const socket = this.socket;
    this.socket = undefined;
    this.generation += 1;
    clearTimeout(this.retryTimer);
    this.pause();
    this.connection = "desconectado";
    this.code = null;
    this.qr = null;
    return socket;
  }

  private async connect(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.generation += 1;
    const generation = this.generation;
    this.connection = "conectando";
    try {
      await this.authWrites;
      const auth = await this.deps.loadAuth();
      if (generation !== this.generation) {
        return;
      }
      if (isLinked(auth.state.creds)) {
        this.linking = "vinculado";
      } else if (this.linking === "vinculado") {
        // A read failure yields blank credentials: never mistake that for a session to register or delete.
        throw new Error("La sesión leída no está vinculada.");
      }
      const socket = this.deps.openSocket(auth.state);
      this.socket = socket;
      this.listen(socket, auth, generation);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.deps.log.error({ err: error }, "No pude abrir la conexión con WhatsApp.");
      if (this.linking === "vinculado") {
        this.connection = "desconectado";
        this.notice = NOTICE_UNREADABLE;
        this.scheduleRetry();
      } else if (error instanceof UnreadableSessionError) {
        this.dropSocket();
        this.refuseLinking(error);
      } else {
        await this.abandonLinking(NOTICE_LINKING_INCOMPLETE);
      }
    }
  }

  private listen(socket: WASocket, auth: SessionAuth, generation: number): void {
    socket.ev.on("creds.update", () => {
      if (generation === this.generation) {
        this.authWrites = this.authWrites
          .then(() => auth.saveCreds())
          .catch((error: unknown) => this.deps.log.error({ err: error }, "No pude guardar la sesión."));
      }
    });
    socket.ev.on("connection.update", (update) => {
      if (generation === this.generation) {
        this.onConnectionUpdate(socket, auth.state.creds, update);
      }
    });
    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (generation !== this.generation || type !== "notify") {
        return;
      }
      for (const message of messages) {
        this.dispatch(socket, message);
      }
    });
  }

  private dispatch(socket: WASocket, message: WAMessage): void {
    // A message without a timestamp counts as old: staying silent is the safe choice.
    const sentAt = Number(message.messageTimestamp ?? 0) * 1000;
    if (this.activeSince === undefined || sentAt < this.activeSince - ACTIVATION_TOLERANCE_MS) {
      return;
    }
    const { singleVideo } = this.deps;
    if (singleVideo !== undefined) {
      if (!singleVideo(socket, message)) {
        return;
      }
      // Taken before any await, and without aborting `jobs`: this video's result must still be sent.
      this.activeSince = undefined;
      this.notice = NOTICE_SINGLE_VIDEO;
    }
    this.deps.onMessage(socket, message, this.jobs.signal).catch((error: unknown) => {
      this.deps.log.error({ err: error }, "Error inesperado al procesar un mensaje.");
    });
  }

  private onConnectionUpdate(socket: WASocket, creds: AuthenticationCreds, update: Partial<ConnectionState>): void {
    if (update.qr !== undefined && this.linking === "vinculando") {
      this.onPairingReady(socket, update.qr);
    }
    if (update.isNewLogin) {
      this.linking = "vinculado";
      this.code = null;
      this.qr = null;
      this.deps.log.info("Dispositivo vinculado.");
    }
    if (update.connection === "open") {
      this.linking = "vinculado";
      this.connection = "conectado";
      this.code = null;
      this.qr = null;
      this.notice = this.pausedByDisconnection ? NOTICE_STILL_PAUSED : null;
      this.retries = 0;
      this.restartedWithoutOpening = false;
      this.deps.log.info("Conectado a WhatsApp. El bot está en pausa.");
    }
    if (update.connection === "close") {
      const error = update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
      const statusCode = error?.output?.statusCode;
      // The logout we asked for ends the socket too; unlink() takes care of it.
      if (this.unlinking && statusCode === DisconnectReason.loggedOut) {
        return;
      }
      if (isLinked(creds)) {
        this.linking = "vinculado";
      }
      this.onClose(statusCode);
    }
  }

  /** The first `qr` event means the handshake is done: only then can a pairing code be requested. */
  private onPairingReady(socket: WASocket, qr: string): void {
    if (this.linkMethod === "qr") {
      this.qr = qr;
      this.deps.showQr(qr);
      return;
    }
    const phone = this.linkPhone;
    if (this.pairingCodeRequested || phone === undefined) {
      return;
    }
    this.pairingCodeRequested = true;
    const generation = this.generation;
    socket.requestPairingCode(phone).then(
      (code) => {
        if (generation === this.generation && this.linking === "vinculando") {
          this.code = formatPairingCode(code);
          this.deps.showPairingCode(code);
        }
      },
      (error: unknown) => {
        this.deps.log.error({ err: error }, "No pude pedir el código de vinculación.");
        if (generation === this.generation) {
          void this.abandonLinking(NOTICE_CODE_FAILED);
        }
      },
    );
  }

  private onClose(statusCode: number | undefined): void {
    const wasActive = this.activeSince !== undefined;
    this.dropSocket();
    this.deps.log.warn({ statusCode }, "Conexión con WhatsApp cerrada. El bot queda en pausa.");
    this.pausedByDisconnection ||= wasActive;

    if (this.linking !== "vinculado") {
      this.linking = "sin-vincular";
      this.notice = NOTICE_LINKING_INCOMPLETE;
      void this.forgetAuth();
    } else if (statusCode === DisconnectReason.loggedOut) {
      this.linking = "sin-vincular";
      this.pausedByDisconnection = false;
      this.notice = NOTICE_LOGGED_OUT;
      void this.forgetAuth();
    } else if (statusCode === DisconnectReason.connectionReplaced) {
      this.notice = NOTICE_REPLACED;
    } else if (statusCode === DisconnectReason.restartRequired && !this.restartedWithoutOpening) {
      // Expected right after pairing.
      this.restartedWithoutOpening = true;
      void this.connect();
    } else {
      this.notice = NOTICE_LOST;
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    const wait = Math.min(FIRST_RETRY_MS * 2 ** this.retries, MAX_RETRY_MS);
    this.retries += 1;
    this.retryTimer = setTimeout(() => void this.connect(), wait);
  }

  private refuseLinking(error: UnreadableSessionError): void {
    this.damagedSession = true;
    this.linking = "sin-vincular";
    this.notice = NOTICE_DAMAGED;
    this.deps.log.error({ err: error }, NOTICE_DAMAGED);
  }

  /** Files are only deleted when this attempt got to open a socket and may have written them. */
  private async abandonLinking(notice: string | null): Promise<void> {
    const socket = this.dropSocket();
    this.linking = "sin-vincular";
    this.notice = notice;
    if (socket === undefined) {
      return;
    }
    const cleared = this.forgetAuth();
    void socket.end(undefined);
    await cleared;
  }

  private forgetAuth(): Promise<void> {
    this.authWrites = this.authWrites
      .then(() => this.deps.clearAuth())
      .catch((error: unknown) => {
        this.notice = NOTICE_NOT_CLEARED;
        this.deps.log.error({ err: error }, NOTICE_NOT_CLEARED);
      });
    return this.authWrites;
  }
}
