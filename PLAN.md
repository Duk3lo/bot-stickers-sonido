# Plan: la app prepara el vídeo y el bot lo ajusta

Objetivo: en el «Conversor de stickers» se prepara el vídeo (recorte, encuadre, forma) y se comparte
directamente al chat del bot con un texto de ajustes. El bot lee ese texto y devuelve el sticker con sonido.

La app hace el trabajo de imagen; el bot solo entiende unos pocos ajustes de tiempo. Así no se duplica
la lógica del editor.

## Formato del texto de ajustes (pie del vídeo)

`inicio=2 fin=7 sonido=5`

- `inicio`, `fin`: segundos (admite decimales con punto o coma). `0 <= inicio < fin`.
- `sonido`: segundos de audio, entero de 1 a `MAX_SOUND_SECONDS`.
- Todos opcionales; sin pie, el comportamiento es el actual.
- Claves desconocidas o valores inválidos: el bot responde en español qué está mal y no procesa.
- Palabra suelta `ayuda`: el bot responde con el formato.

## Tareas

### Bot (bot-stickers-sonido, rama `terminar-bot`)
- [x] B1. `src/ajustes.ts`: parsear y validar el pie → `{ inicio?, fin?, sonido? }` o lista de errores. Pruebas.
- [x] B2. ffmpeg: aplicar `inicio`/`fin` (`-ss`/`-to` como argumentos separados) al WebP y al OGG. Pruebas de argumentos.
- [x] B3. `bot.ts`: leer el pie (`videoMessage.caption` / `documentMessage.caption`), errores en español, ayuda con el formato. README actualizado.
  Verificación: `npm test`, `npm run typecheck`; prueba manual de `buildSoundSticker` con un tramo.

### App (conversor-stickers, rama nueva desde `wip/abrir-whatsapp` cuando termine)
- [x] A1. Ajuste «Número del bot» (opcional, guardado en la configuración local; validado: solo dígitos, 8–15).
- [x] A2. (rama `enviar-al-bot`) Decisión: el clip guardado ya va recortado al tramo, así que la app solo
  envía `sonido=N`; mandar `inicio/fin` haría recortar dos veces. Botón «Enviar al bot» tras «Sticker con sonido»: Android `ACTION_SEND` del vídeo a WhatsApp con
  `jid=<número>@s.whatsapp.net` y el pie de ajustes (tramo elegido en el editor). Sin número: se oculta.
  Prueba Kotlin del intent y prueba TS del texto de ajustes.
  Verificación: `npm run check`, `cargo clippy`, `cargo test`, test Kotlin.

### Pendiente del usuario
- Vincular el número secundario (`.env` + `! npm run dev`) y probar el envío real.

## Fase 2: bot de uso personal con aviso aceptado (2026-11-25)

Decisión del usuario: el bot no va dentro de la app; vive solo en GitHub y cada persona lo instala con su
propio número, bajo su responsabilidad. En la app, «Enviar al bot» es un extra oculto que solo aparece tras
aceptar el mismo aviso.

### Bot (rama `terminar-bot`)
- [x] C1. `AVISO.md` en español: cliente no oficial (Baileys), no afiliado a WhatsApp/Meta, riesgo de bloqueo
  de la cuenta, solo uso personal (la lista de números es para el propio dueño), el usuario es responsable de
  su cuenta y del contenido, sin garantía, los vídeos se procesan en local y se borran al terminar.
- [x] C2. El bot no arranca sin `ACEPTO_AVISO=si` en `.env`: si falta, error en español que remite a AVISO.md.
  En `.env.example` comentado. Prueba en config.test.ts.
- [x] C3. README: sección «Instálalo con tu propio número» y enlace a AVISO.md.
- Pendiente del usuario: elegir licencia (hoy UNLICENSED).

### App (conversor-stickers, rama `enviar-al-bot`)
- [x] D1. (97352cf) Sección «Extensiones (opcional)»: muestra el aviso, casilla «He leído y acepto», enlace al repo
  del bot. Sin aceptar, ni el campo «Número del bot» ni «Enviar al bot» aparecen. Aceptación guardada en
  local y revocable. Pruebas TS.

## Fase 3: control desde la app (2026-11-26, rama `mejoras-vinculacion`)

Contrato y reglas completas en la sección T4 de `PLAN.md` del repo conversor-stickers.
- [x] G1. Pausa por defecto y ante cualquier desconexión; ignorar lo anterior a la activación; reconexión creciente.
- [x] G2. Vinculación a demanda (código o QR) y desvinculación.
- [x] G3. API local con token (solo 127.0.0.1).
- [x] G4. Registros sin números, códigos, QR ni tokens.
- [x] G5. Servicio `systemd --user`, README (Tailscale) y `.env.example`.
- [x] G6. Modo de chat propio (`MODO_CHAT_PROPIO=si`, apagado por defecto): un video por activación.
- Pendiente: prueba manual con WhatsApp real.
- [x] G6. Modo de chat propio y encuadre (`encuadre=recortar zoom= x= y=`).
- Pendiente: probar con WhatsApp real.

## Fase 4: vincular desde la app sin tocar el `.env` (pedido el 2026-11-27)
- [x] H1. `POST /vinculacion` admite `numero` (solo con `codigo`), validado en la API; sin él se usa
  `PAIRING_PHONE`. Pruebas en control-api y whatsapp-session. README.
- [x] H3. Enlace de conexión `conversorstickers://bot#u=…&t=…` y su QR al arrancar en terminal
  interactiva (Tailscale si hay, si no 127.0.0.1). Pruebas en enlace-conexion y logger. README.
- [x] H4. Conexión en la misma Wi-Fi sin Tailscale: `ESCUCHAR_EN_RED=si|no` (por defecto si, 0.0.0.0) con filtro
  de origen (loopback, privadas, Tailscale) y de `Host` (IPv4 privada con puerto); token en
  `~/.config/bot-stickers-sonido/` (0700/0600, migra el `./control-token` antiguo) con `conexion.json`;
  el enlace prefiere la IPv4 privada de la PC (primera con QR, otras en texto) y avisa del cortafuegos (`ufw`).
  Pruebas en red-local, control-token, control-api, config y enlace-conexion.
- [ ] H2. App (conversor-stickers): campo para el número y QR visible también en Android.
