# bot-stickers-sonido

Bot de WhatsApp que convierte un vídeo corto en un sticker animado con sonido. Solo responde a los números de `ALLOWED_NUMBERS`; ignora en silencio a cualquier otro remitente, así como grupos y difusiones.

## Aviso importante

Este proyecto usa [Baileys](https://github.com/WhiskeySockets/Baileys), un **cliente no oficial** de WhatsApp Web. WhatsApp puede **bloquear o suspender la cuenta** que lo use. Usa un **número secundario**, nunca tu cuenta principal. El proyecto no está afiliado, respaldado ni patrocinado por WhatsApp ni por Meta.

## Instálalo con tu propio número

Este bot no se ofrece como servicio: cada persona lo instala y lo ejecuta con su propio número, bajo su responsabilidad. Antes de arrancarlo, lee [AVISO.md](AVISO.md) y, si lo aceptas, añade `ACEPTO_AVISO=si` a tu `.env`; sin esa línea el bot no arranca.

1. Sigue los pasos de [Requisitos](#requisitos) e [Instalación](#instalación).
2. Vincula un número secundario como se explica en [Vinculación](#vinculación-primer-inicio).
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

## Vinculación (primer inicio)

1. Pon en `.env` tu `ALLOWED_NUMBERS`.
2. Ejecuta `npm start`. Por defecto aparece un código QR en la terminal (se redibuja cuando caduca).
3. En el móvil del bot: WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo, y escanea el QR.
4. Al vincular verás «Vinculado. Ya puedes enviarle vídeos desde tu número.»

Alternativa con código: pon `PAIRING_PHONE` (número de la cuenta del bot, con código de país). Aparecerá un código `ABCD-EFGH`; introdúcelo en WhatsApp → Dispositivos vinculados → Vincular un dispositivo → Vincular con número de teléfono. Después puedes quitar `PAIRING_PHONE`.

El QR se dibuja con `qrcode-terminal` (versión exacta 0.12.0): librería mínima y sin dependencias que dibuja el QR en la terminal; Baileys ya no lo hace por su cuenta.

Si WhatsApp cierra la sesión, borra la carpeta `auth/` y vuelve a vincular.

## Uso

Desde un número autorizado, envía al bot un vídeo (o un documento de vídeo, hasta 25 MB). Responde con un sticker animado (imagen de máx. 10 s y 500 KB) con el audio adjunto. Si no puede enviarlo con sonido, envía el sticker sin audio. Límites: un vídeo a la vez por remitente y 5 cada 10 minutos.

### Ajustes en el texto del vídeo

Opcionalmente, escribe en el pie del vídeo (o del documento) ajustes separados por espacios, por ejemplo `inicio=2 fin=7 sonido=5`:

- `inicio`, `fin`: segundos del tramo a usar (admite decimales con punto o coma). Debe cumplirse `0 <= inicio < fin`; un `fin` mayor que la duración se recorta al final del vídeo.
- `sonido`: segundos de audio, entero de 1 a `MAX_SOUND_SECONDS`.

Sin `sonido`, el audio dura lo mismo que la imagen (queda sincronizado). Con `sonido=N` se respeta N aunque supere la imagen: WhatsApp reproduce el audio entero, pero deja de animar el sticker cuando acaba la imagen (máx. 10 s) y el resto suena con la imagen quieta. En ese caso el bot avisa con un mensaje tras enviar el sticker.

Sin pie, se usa el vídeo entero. Si hay una clave desconocida o un valor no válido, el bot explica el error en español y no procesa el vídeo. Escribir `ayuda` devuelve este formato.

## Variables de `.env`

| Variable | Descripción |
| --- | --- |
| `ACEPTO_AVISO` | Obligatoria. Debe ser `si`: indica que has leído y aceptas [AVISO.md](AVISO.md). |
| `ALLOWED_NUMBERS` | Obligatoria. Números con código de país, sin `+`, separados por comas. |
| `MAX_SOUND_SECONDS` | Duración máxima del audio, entero entre 1 y 60 (por defecto 10). Más de 10 s es experimental: se desconoce el límite real de WhatsApp. |
| `AUTH_DIR` | Carpeta de la sesión (por defecto `./auth`). |
| `PAIRING_PHONE` | Opcional. Si se define en el primer inicio, vincula con código en vez de QR. |
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

`auth/` contiene las credenciales de la sesión de WhatsApp: quien las tenga controla la cuenta. Está en `.gitignore` y **nunca** debe subirse ni compartirse. Lo mismo para `.env`.
