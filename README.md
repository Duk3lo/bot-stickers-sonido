# bot-stickers-sonido

Bot de WhatsApp que convierte un vídeo corto en un sticker animado con sonido. Salvo en el [modo de chat propio](#modo-de-chat-propio), solo responde a los números de `ALLOWED_NUMBERS`; ignora en silencio a cualquier otro remitente, así como grupos y difusiones.

## Aviso importante

Este proyecto usa [Baileys](https://github.com/WhiskeySockets/Baileys), un **cliente no oficial** de WhatsApp Web. WhatsApp puede **bloquear o suspender la cuenta** que lo use. Usa un **número secundario**, nunca tu cuenta principal. El proyecto no está afiliado, respaldado ni patrocinado por WhatsApp ni por Meta.

## Instálalo con tu propio número

Este bot no se ofrece como servicio: cada persona lo instala y lo ejecuta con su propio número, bajo su responsabilidad. Antes de arrancarlo, lee [AVISO.md](AVISO.md) y, si lo aceptas, añade `ACEPTO_AVISO=si` a tu `.env`; sin esa línea el bot no arranca.

1. Sigue los pasos de [Requisitos](#requisitos) e [Instalación](#instalación).
2. Vincula un número secundario como se explica en [Vinculación](#vinculación).
3. Pon en `ALLOWED_NUMBERS` solo tu número (o el de gente de tu confianza).

## Instálalo en la app

El archivo [extension.json](extension.json) es el manifiesto para instalar este bot como extensión en la app conversor-stickers (instalar desde archivo `.json`). El número de destino lo eliges tú al activarla.

## Requisitos

- Node.js >= 22.9
- `ffmpeg` y `ffprobe` en el `PATH` (con soporte de `libwebp` y `libopus`)

## Instalación rápida

```sh
./instalar.sh [ruta/a/conversor-stickers]
```

Comprueba Node y ffmpeg, instala dependencias, compila y crea el `.env` (si no existe) preguntándote los números y la aceptación de `AVISO.md`. No usa `sudo` ni instala paquetes del sistema.

## Instalación manual

```sh
npm ci
cp .env.example .env   # y edítalo
npm run build
```

## Vinculación

El bot no se vincula solo: sin sesión no abre conexión con WhatsApp ni pide códigos hasta que lo solicitas, desde la app o con la [API de control](#api-de-control).

1. Ejecuta `npm start` en una terminal.
2. En otra, solicita la vinculación (los ejemplos son para fish; define antes `token` como en [Ver el token](#ver-el-token)):

   ```fish
   curl -X POST -H "Authorization: Bearer $token" -d '{"metodo":"qr"}' http://127.0.0.1:8787/vinculacion
   ```

3. El QR (o el código `ABCD-EFGH`) aparece en la terminal del bot. Solo se imprime en una terminal interactiva, nunca cuando corre como servicio; en ese caso se obtiene con `GET /estado` (campos `qr` y `codigo`) o desde la app.
4. En el móvil del bot: WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo. Escanea el QR o elige «Vincular con número de teléfono» e introduce el código.

Para vincular con código (`"metodo":"codigo"`) hace falta `PAIRING_PHONE` en `.env` (número de la cuenta del bot, con código de país). Si el intento caduca o no se completa, se descartan sus credenciales y no se repite solo: vuelve a solicitarlo.

El QR se dibuja con `qrcode-terminal` (versión exacta 0.12.0): librería mínima y sin dependencias que dibuja el QR en la terminal; Baileys ya no lo hace por su cuenta.

Para desvincular usa `DELETE /vinculacion` con el bot conectado (o el botón de la app). Si cierras la sesión desde el teléfono, el bot borra sus credenciales y queda sin vincular. Al borrar la sesión solo se eliminan los archivos de Baileys de `AUTH_DIR`, no la carpeta ni otros archivos.

Si `creds.json` existe pero no se puede leer (permisos o archivo dañado), el bot lo indica en el aviso, no borra nada y no permite vincular. Corrige los permisos, o mueve el archivo a otra carpeta, y reinicia el bot.

## Pausa

Para no responder sin querer (por ejemplo, a una avalancha de mensajes atrasados):

- El bot arranca **en pausa**. En pausa ignora todo en silencio.
- Solo se activa si lo pides (`POST /activar` o la app) y únicamente con WhatsApp conectado.
- Cualquier cierre de la conexión lo pone en pausa, y **no se reactiva solo** al reconectar.
- Activo, ignora los mensajes enviados antes de la activación (con 30 s de tolerancia).
- Si se pausa mientras procesa un video, no envía el resultado ni avisos. Lo que ya estuviera saliendo hacia WhatsApp en ese instante no se puede retirar.
- Si se pierde la conexión, reintenta con una espera creciente (de 5 s a 5 min). Si otra sesión reemplaza a esta, no insiste: reinicia el bot.

## Modo de chat propio

Apagado por defecto. Sirve para probar el bot vinculado a tu propio número, enviando los videos a tu chat contigo mismo. Se enciende con `MODO_CHAT_PROPIO=si`.

> **Riesgo:** vincular tu número principal a un cliente no oficial puede hacer que WhatsApp **bloquee tu cuenta**, aunque lo uses una sola vez. **Desvincula al terminar** y vuelve a poner `MODO_CHAT_PROPIO=no`.

Con el modo encendido:

- Solo se procesan videos (también como documento) que envíes a tu propio chat. Todo lo demás se ignora en silencio, incluidos los números de `ALLOWED_NUMBERS`, que en este modo no es obligatorio.
- Sigue haciendo falta activar el bot, y se ignora lo anterior a la activación.
- **Se pausa solo tras un video**, salga bien o mal. Actívalo de nuevo para el siguiente. Para cancelar el que está procesando, usa la pausa.
- No envía la ayuda ni «Procesando el video…», y nunca reacciona a los mensajes que él mismo envía.
- **Limitación con Meta AI:** un video que envíes desde el teléfono al chat de **Meta AI** podría tomarse como enviado a tu propio chat, porque Baileys 7.0.0-rc14 (`decode-wa-message`) ignora ese destinatario y deja como chat tu propia dirección. En ese caso el bot lo procesaría. No envíes videos a Meta AI mientras el bot esté activo.

## API de control

Escucha solo en `127.0.0.1:CONTROL_PORT` (8787). Cada petición necesita `Authorization: Bearer <token>`.

| Petición | Qué hace |
| --- | --- |
| `GET /estado` | Devuelve vinculación, conexión, si está activo, código o QR y el último aviso. |
| `POST /activar` | Activa el bot. 409 sin conexión con WhatsApp. |
| `POST /pausar` | Lo pone en pausa. |
| `POST /vinculacion` | Cuerpo `{"metodo":"codigo"}` o `{"metodo":"qr"}`. |
| `DELETE /vinculacion` | Desvincula. 409 si no está vinculado y conectado. |

Además: solo admite el `Host` `127.0.0.1`, `localhost` o `*.ts.net`; rechaza las peticiones con `Origin` (navegadores) y los cuerpos de más de 1 KiB; tras 10 tokens erróneos en un minuto, las peticiones con token erróneo reciben 429 hasta que pase la ventana. Las que llevan el token correcto se atienden siempre, para que nada te impida pausar el bot.

El bot abre el puerto antes de leer la sesión: si ya está ocupado (por ejemplo, por otra instancia), termina sin tocar `AUTH_DIR`.

### Ver el token

El token se crea en el primer arranque en `CONTROL_TOKEN_FILE` (`./control-token`, permisos 0600). Míralo solo en tu propia terminal, sin pegarlo en chats ni capturas. Desde la carpeta del bot, en fish:

```fish
cat control-token                 # para copiarlo en la app
set token (cat control-token)     # para los ejemplos con curl
curl -H "Authorization: Bearer $token" http://127.0.0.1:8787/estado
```

Para cambiarlo, borra el archivo y reinicia el bot.

### Acceso desde el celular con Tailscale

Con [Tailscale](https://tailscale.com) instalado y la sesión iniciada en el equipo del bot y en el celular:

```fish
tailscale serve --bg 8787
tailscale serve status    # muestra la dirección https://….ts.net que se pone en la app
```

Así la API solo es accesible dentro de tu red de Tailscale, con HTTPS. **No uses `tailscale funnel`** ni abras puertos en el router: publicarían el control del bot en internet. Para dejar de compartirla: `tailscale serve reset` (borra toda la configuración de `serve` del equipo).

## Servicio (systemd)

Para que el bot corra en segundo plano como servicio de tu usuario, tras `./instalar.sh`:

```fish
./instalar-servicio.sh
systemctl --user daemon-reload
systemctl --user enable --now bot-stickers-sonido
journalctl --user -u bot-stickers-sonido -f     # registros
```

El script no usa `sudo` ni arranca nada: solo escribe la unidad en `~/.config/systemd/user/` con las rutas de esta carpeta, de Node y de ffmpeg. Vuelve a ejecutarlo si mueves la carpeta o cambias de versión de Node. Tras editar `.env` o recompilar, usa `systemctl --user restart bot-stickers-sonido`. El servicio también arranca en pausa. Si quieres que siga activo sin tu sesión iniciada, activa `loginctl enable-linger`.

No ejecutes a la vez el servicio y `npm start`.

## Registros

Los registros no incluyen números, JID, códigos, QR ni el token: toda secuencia de 6 o más dígitos y todo JID se sustituyen por `[oculto]`, también en los errores de Baileys. De lo que sus dependencias escriben en la consola solo se conserva el texto inicial, saneado y en nivel `debug`.

## Uso

Con el bot [activo](#pausa), desde un número autorizado, envía al bot un vídeo (o un documento de vídeo, hasta 25 MB). Responde con un sticker animado (imagen de máx. 10 s y 500 KB) con el audio adjunto. Si no puede enviarlo con sonido, envía el sticker sin audio. Límites: un vídeo a la vez por remitente y 5 cada 10 minutos. Las respuestas que no procesan nada (ayuda, «no es un video», ajustes erróneos, ocupado o límite alcanzado) se envían como mucho una de cada tipo y 3 en total por chat cada 10 minutos; después, el bot calla.

### Ajustes en el texto del vídeo

Opcionalmente, escribe en el pie del vídeo (o del documento) ajustes separados por espacios, por ejemplo `inicio=2 fin=7 sonido=5`:

- `inicio`, `fin`: segundos del tramo a usar (admite decimales con punto o coma). Debe cumplirse `0 <= inicio < fin`; un `fin` mayor que la duración se recorta al final del vídeo.
- `sonido`: segundos de audio, entero de 1 a `MAX_SOUND_SECONDS`.
- `encuadre`: `entero` (por defecto: todo el video, con bordes transparentes) o `recortar` (llena el cuadrado).
  Con `recortar` se puede añadir `zoom` (1 a 4) y el centro `x` e `y` (0 a 1). La app los envía sola según lo que
  ves en su editor. El sticker recortado se genera con ffmpeg aunque haya `CONVERSOR_BIN`.

Sin `sonido`, el audio dura lo mismo que la imagen (queda sincronizado). Con `sonido=N` se respeta N aunque supere la imagen: WhatsApp reproduce el audio entero, pero deja de animar el sticker cuando acaba la imagen (máx. 10 s) y el resto suena con la imagen quieta. En ese caso el bot avisa con un mensaje tras enviar el sticker.

Sin pie, se usa el vídeo entero. Si hay una clave desconocida o un valor no válido, el bot explica el error en español y no procesa el vídeo. Escribir `ayuda` devuelve este formato.

## Variables de `.env`

| Variable | Descripción |
| --- | --- |
| `ACEPTO_AVISO` | Obligatoria. Debe ser `si`: indica que has leído y aceptas [AVISO.md](AVISO.md). |
| `ALLOWED_NUMBERS` | Obligatoria. Números con código de país, sin `+`, separados por comas. |
| `MAX_SOUND_SECONDS` | Duración máxima del audio, entero entre 1 y 60 (por defecto 10). Más de 10 s es experimental: se desconoce el límite real de WhatsApp. |
| `AUTH_DIR` | Carpeta de la sesión (por defecto `./auth`). |
| `PAIRING_PHONE` | Opcional. Necesario solo para vincular con código. |
| `CONTROL_PORT` | Puerto de la API de control en `127.0.0.1` (por defecto 8787). |
| `CONTROL_TOKEN_FILE` | Archivo del token de la API (por defecto `./control-token`). Si cambias la ruta, déjalo fuera del repositorio. |
| `MODO_CHAT_PROPIO` | `si` o `no` (por defecto). Ver [Modo de chat propio](#modo-de-chat-propio). |
| `SOUND_WIRE_FORMAT` | `sticker-field-26` (por defecto) o `audio-sticker-134`. |
| `CONVERSOR_BIN` | Opcional. Ruta absoluta al binario `conversor-stickers`; si se define, genera el WebP (más rápido y con mejor ajuste de peso). Si no, se usa ffmpeg. |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn` o `error`. |

### `CONVERSOR_BIN`

El binario sale del proyecto `conversor-stickers`. Para compilarlo, desde su carpeta:

```sh
cargo build --release -p conversor-stickers
```

Después apunta `CONVERSOR_BIN` a `target/release/conversor-stickers`. El OGG sigue haciéndose con ffmpeg y el envío con Baileys.

### `SOUND_WIRE_FORMAT` (experimental)

WhatsApp no documenta los stickers con sonido: el bot los envía inyectando el audio en el protocolo de forma no oficial. `sticker-field-26` y `audio-sticker-134` son dos variantes de esa codificación; si una no funciona en tu versión de WhatsApp, prueba la otra. Puede dejar de funcionar en cualquier momento.

## Pruebas

```sh
npm test            # compila y ejecuta las pruebas
npm run typecheck
```

## Licencia

[MIT](LICENSE).

## Seguridad

`auth/` contiene las credenciales de la sesión de WhatsApp: quien las tenga controla la cuenta. Está en `.gitignore` y **nunca** debe subirse ni compartirse. Lo mismo para `.env` y para `control-token`, que permite controlar el bot.
