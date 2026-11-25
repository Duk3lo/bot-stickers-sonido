import qrcode from "qrcode-terminal";

export const MSG_LINKED = "Vinculado. Ya puedes enviarle vídeos desde tu número.";

/** Formats the 8-character pairing code as ABCD-EFGH; any other length is returned unchanged. */
export function formatPairingCode(raw: string): string {
  const code = raw.replace(/-/g, "").toUpperCase();
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function qrInstructions(): string {
  return [
    "Escanea este código QR para vincular el bot:",
    "WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo y escanea.",
    "El QR caduca: si cambia, escanea el nuevo.",
  ].join("\n");
}

export function pairingCodeInstructions(rawCode: string): string {
  return [
    "",
    "==============================",
    `  CÓDIGO DE VINCULACIÓN: ${formatPairingCode(rawCode)}`,
    "==============================",
    "WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo → Vincular con número de teléfono, e introduce el código.",
    "",
  ].join("\n");
}

/** Draws the QR straight to stdout (not through the JSON logger) so it stays scannable. */
export function printQr(qr: string): void {
  qrcode.generate(qr, { small: true }, (drawing) => {
    process.stdout.write(`\n${qrInstructions()}\n${drawing}\n`);
  });
}

export function printPairingCode(rawCode: string): void {
  process.stdout.write(pairingCodeInstructions(rawCode));
}
