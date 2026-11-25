import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { startBot } from "./bot.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  logger.info(
    { allowedCount: config.allowedNumbers.size, maxSoundSeconds: config.maxSoundSeconds, wireFormat: config.wireFormat },
    "Configuración cargada.",
  );
  await startBot({ config });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.fatal({ err: error }, message);
  process.exitCode = 1;
});
