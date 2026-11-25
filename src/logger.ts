import pino from "pino";

export const logger = pino({
  name: "bot-stickers-sonido",
  level: process.env["LOG_LEVEL"] ?? "info",
});

export type Logger = typeof logger;
