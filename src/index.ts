import makeWASocket, { Browsers } from "@whiskeysockets/baileys";
import { clearAuthFiles, loadAuthState } from "./auth-files.js";
import { handleMessage, isOwnChatVideo, type BotContext } from "./bot.js";
import { loadConfig } from "./config.js";
import { startControlServer } from "./control-api.js";
import { setUpControlToken } from "./control-token.js";
import { printConnectionLink } from "./enlace-conexion.js";
import { JobGate } from "./job-gate.js";
import { captureConsole, logger } from "./logger.js";
import { AudioStickerRegistry, installSoundStickerPatch } from "./sound-sticker.js";
import { printPairingCode, printQr } from "./vinculacion.js";
import { WhatsAppSession } from "./whatsapp-session.js";

async function main(): Promise<void> {
  captureConsole(logger);
  const config = loadConfig(process.env);
  logger.info(
    { allowedCount: config.allowedNumbers.size, maxSoundSeconds: config.maxSoundSeconds, wireFormat: config.wireFormat },
    "Configuración cargada.",
  );

  const registry = new AudioStickerRegistry();
  installSoundStickerPatch(config.wireFormat, registry);
  const context: BotContext = { config, registry, gate: new JobGate(), sentIds: new Set(), log: logger };
  if (config.ownChatMode) {
    logger.warn("Modo de chat propio: solo videos de tu chat contigo, uno por activación. Desvincula al terminar.");
  }
  // As a service, stdout ends up in the journal: the code and the QR are only shown on a real terminal.
  const interactive = process.stdout.isTTY === true;

  const session = new WhatsAppSession({
    loadAuth: () => loadAuthState(config.authDir),
    openSocket: (state) =>
      makeWASocket({
        auth: state,
        browser: Browsers.ubuntu("Chrome"),
        logger: logger.child({ module: "baileys" }, { level: "warn" }),
        markOnlineOnConnect: false,
      }),
    clearAuth: () => clearAuthFiles(config.authDir),
    onMessage: (sock, message, signal) => handleMessage(sock, message, context, signal),
    singleVideo: config.ownChatMode
      ? (sock, message) => isOwnChatVideo(sock.user, message, context.sentIds)
      : undefined,
    pairingPhone: config.pairingPhone,
    showQr: (qr) => {
      if (interactive) {
        printQr(qr);
      }
    },
    showPairingCode: (code) => {
      if (interactive) {
        printPairingCode(code);
      }
    },
    log: logger,
  });
  const token = await setUpControlToken({ env: process.env, port: config.controlPort });
  await startControlServer({
    session,
    token,
    log: logger,
    port: config.controlPort,
    listenOnNetwork: config.listenOnNetwork,
    restore: () => session.restore(),
  });
  logger.info(
    { port: config.controlPort, listenOnNetwork: config.listenOnNetwork },
    config.listenOnNetwork
      ? "API de control escuchando en la red local (solo se atienden orígenes locales, privados o de Tailscale). El bot está en pausa."
      : "API de control escuchando solo en 127.0.0.1. El bot está en pausa.",
  );
  if (session.status().vinculacion === "sin-vincular") {
    logger.info("El bot no está vinculado: solicita la vinculación desde la app o la API (ver README).");
  }

  if (interactive) {
    await printConnectionLink({
      token,
      port: config.controlPort,
      listenOnNetwork: config.listenOnNetwork,
      log: logger,
    });
  }

  session.resume();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.fatal({ err: error }, message);
  process.exitCode = 1;
});
