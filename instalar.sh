#!/usr/bin/env bash
# Deja el bot listo: comprueba requisitos, instala, compila y crea .env.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
conversor_dir="${1:-../conversor-stickers}"

error() { echo "Error: $*" >&2; exit 1; }

# Requisitos
command -v node >/dev/null 2>&1 || error "Falta Node.js >= 22.9. Instálalo con tu gestor de paquetes o con nvm (https://github.com/nvm-sh/nvm)."
node_version="$(node -p 'process.versions.node')"
IFS=. read -r node_major node_minor _ <<<"$node_version"
if (( node_major < 22 || (node_major == 22 && node_minor < 9) )); then
  error "Node.js $node_version es demasiado antiguo; hace falta >= 22.9."
fi
for herramienta in ffmpeg ffprobe; do
  command -v "$herramienta" >/dev/null 2>&1 \
    || error "Falta $herramienta. Instala ffmpeg con tu gestor de paquetes (p. ej. 'sudo apt install ffmpeg' o 'sudo pacman -S ffmpeg') y vuelve a ejecutar."
done
echo "Requisitos correctos (Node $node_version, ffmpeg, ffprobe)."

echo "Instalando dependencias..."
npm ci
echo "Compilando..."
npm run build

# Conversor opcional
conversor_bin=""
if [[ -d "$conversor_dir" ]]; then
  if command -v cargo >/dev/null 2>&1; then
    echo "Compilando conversor-stickers en $conversor_dir..."
    (cd "$conversor_dir" && cargo build --release -p conversor-stickers)
    # La carpeta de compilación puede estar fuera del proyecto (target-dir en ~/.cargo/config.toml).
    target_dir="$(cd "$conversor_dir" && cargo metadata --format-version 1 --no-deps \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).target_directory))')"
    conversor_bin="$target_dir/release/conversor-stickers"
    echo "Conversor listo: $conversor_bin"
  else
    echo "Aviso: existe $conversor_dir pero falta cargo; se omite el conversor (se usará ffmpeg)."
  fi
else
  echo "No se encontró conversor-stickers en $conversor_dir; se usará ffmpeg."
fi

# .env
if [[ -e .env ]]; then
  echo ".env ya existe; no se modifica."
else
  cp .env.example .env
  chmod 600 .env

  pedir_numeros() { # $1 = variable, $2 = pregunta, $3 = admite lista
    local valor
    while true; do
      read -r -p "$2 " valor
      valor="${valor// /}"
      if [[ "$3" == "lista" ]]; then
        [[ "$valor" =~ ^[0-9]{8,15}(,[0-9]{8,15})*$ ]] && break
      else
        [[ "$valor" =~ ^[0-9]{8,15}$ ]] && break
      fi
      echo "Valor no válido: solo dígitos (8 a 15), con código de país y sin +."
    done
    REPLY_VALOR="$valor"
  }

  echo "¿Cómo quieres vincular?"
  echo "  1) QR (recomendado)"
  echo "  2) Código"
  while true; do
    read -r -p "Opción [1]: " modo
    modo="${modo:-1}"
    [[ "$modo" == "1" || "$modo" == "2" ]] && break
    echo "Opción no válida: escribe 1 o 2."
  done
  pairing=""
  if [[ "$modo" == "2" ]]; then
    pedir_numeros PAIRING_PHONE "Número de la cuenta del bot (con código de país, sin +):" uno
    pairing="$REPLY_VALOR"
  fi
  pedir_numeros ALLOWED_NUMBERS "Números autorizados (separados por comas):" lista
  allowed="$REPLY_VALOR"

  sed -i "s/^PAIRING_PHONE=.*/PAIRING_PHONE=$pairing/; s/^ALLOWED_NUMBERS=.*/ALLOWED_NUMBERS=$allowed/" .env

  echo
  cat AVISO.md
  echo
  read -r -p "Escribe «acepto» para aceptar el aviso: " respuesta
  if [[ "$respuesta" == "acepto" ]]; then
    sed -i 's/^# *ACEPTO_AVISO=si/ACEPTO_AVISO=si/' .env
    echo "Aviso aceptado."
  else
    echo "No has aceptado el aviso: el bot no arrancará hasta que pongas ACEPTO_AVISO=si en .env."
  fi
  if [[ -n "$conversor_bin" ]]; then
    printf 'CONVERSOR_BIN=%s\n' "$conversor_bin" >> .env
  fi
  echo ".env creado."
fi
if [[ -n "$conversor_bin" ]] && ! grep -q '^CONVERSOR_BIN=' .env; then
  echo "Para usar el conversor en Rust, añade a .env: CONVERSOR_BIN=$conversor_bin"
fi

echo
echo "Listo. Ejecuta 'npm start' y solicita la vinculación desde la app o la API (ver README, «Vinculación»)."
