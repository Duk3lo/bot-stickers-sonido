#!/usr/bin/env bash
# Instala la unidad systemd --user del bot. No usa sudo y no habilita ni arranca nada.
set -euo pipefail

directorio="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

error() { echo "Error: $*" >&2; exit 1; }

(( EUID != 0 )) || error "No ejecutes este script con sudo: el servicio es de tu usuario."
[[ -f "$directorio/dist/index.js" ]] || error "El bot no está compilado. Ejecuta antes ./instalar.sh (o npm run build)."
[[ -e "$directorio/.env" ]] || error "Falta .env. Ejecuta antes ./instalar.sh."

for herramienta in node ffmpeg ffprobe; do
  command -v "$herramienta" >/dev/null 2>&1 || error "Falta $herramienta en el PATH."
done
# La ruta real del ejecutable: los gestores de versiones de Node usan enlaces que cambian en cada sesión.
node_bin="$(node -p 'process.execPath')"
ruta="$(dirname "$node_bin"):$(dirname "$(command -v ffmpeg)"):$(dirname "$(command -v ffprobe)"):/usr/local/bin:/usr/bin:/bin"

for valor in "$directorio" "$node_bin" "$ruta"; do
  case "$valor" in
    *[\"\\%\$]* | *$'\n'*) error "Hay una ruta con caracteres que systemd interpreta (\" \\ % \$): $valor" ;;
  esac
done

unidad="$(<"$directorio/systemd/bot-stickers-sonido.service.plantilla")"
unidad="${unidad//@DIRECTORIO@/"$directorio"}"
unidad="${unidad//@NODE@/"$node_bin"}"
unidad="${unidad//@PATH@/"$ruta"}"

destino="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$destino"
printf '%s\n' "$unidad" > "$destino/bot-stickers-sonido.service"

echo "Unidad instalada en $destino/bot-stickers-sonido.service (sin arrancarla)."
echo "Para activarla:"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now bot-stickers-sonido"
echo "Registros: journalctl --user -u bot-stickers-sonido -f"
