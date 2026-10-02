#!/usr/bin/env bash
# One command for a desktop update, run from a Linux checkout of Canvink:
#
#   scripts/release-desktop.sh [patch|minor|x.y.z|--keep-version] [--dest DIR] [--base-url URL] [--notes TEXT]
#
# It bumps the version here, sends the working tree to the configured Windows build host,
# builds and signs the NSIS installer there, and brings the installer and
# latest.json back into DEST (default: public/download of this checkout). The
# web deploy then publishes them. Nothing is deployed or pushed by this script.
#
# The updater signing key comes from the 1Password item "Canvink Tauri updater
# signing key" and travels to the desktop over SSH stdin into the build's
# environment only; it is never written to a file or printed.
#
# The desktop is only used, never powered down: other people's sessions there
# (including the owner) may be running. Wake it first if it is off (see the fleet skill).
set -euo pipefail

: "${DESKTOP_HOST:?Set DESKTOP_HOST to the Windows SSH build host}"
: "${DESKTOP_REMOTE_DIR_WIN:?Set DESKTOP_REMOTE_DIR_WIN to the Windows build directory}"
: "${DESKTOP_REMOTE_DIR_SCP:?Set DESKTOP_REMOTE_DIR_SCP to its SCP path}"
HOST="$DESKTOP_HOST"
REMOTE_DIR_WIN="$DESKTOP_REMOTE_DIR_WIN"
REMOTE_DIR_SCP="$DESKTOP_REMOTE_DIR_SCP"
ITEM='op://agent/Canvink Tauri updater signing key'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

spec="patch"
dest="$ROOT/public/download"
base_url=""
notes=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) dest="$2"; shift 2 ;;
    --base-url) base_url="$2"; shift 2 ;;
    --notes) notes="$2"; shift 2 ;;
    --keep-version) spec=""; shift ;;
    -*) echo "Unknown option $1" >&2; exit 2 ;;
    *) spec="$1"; shift ;;
  esac
done

if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] && [ -r "$HOME/.config/op/service-token" ]; then
  OP_SERVICE_ACCOUNT_TOKEN="$(cat "$HOME/.config/op/service-token")"
  export OP_SERVICE_ACCOUNT_TOKEN
fi
key="$(op read "$ITEM/private key")"
password="$(op read "$ITEM/password")"

if [ -n "$spec" ]; then
  version="$(node scripts/release-desktop.mjs bump "$spec")"
else
  version="$(node -p "require('./package.json').version")"
fi
echo "Releasing Canvink $version"

archive="$(mktemp --suffix=.tgz)"
trap 'rm -f "$archive"' EXIT
git ls-files -z --cached --others --exclude-standard | tar --null --ignore-failed-read -czf "$archive" -T - 2>/dev/null

ssh -o BatchMode=yes "$HOST" "if not exist $REMOTE_DIR_WIN mkdir $REMOTE_DIR_WIN"
scp -q -o BatchMode=yes "$archive" "$HOST:$REMOTE_DIR_SCP/source.tgz"
ssh -o BatchMode=yes "$HOST" "cd /d $REMOTE_DIR_WIN && (for %d in (src public scripts docs tests src-tauri\\src) do if exist %d rmdir /s /q %d) && tar -xzf source.tgz"

build_args="--out public\\download"
[ -n "$base_url" ] && build_args="$build_args --base-url $base_url"
[ -n "$notes" ] && build_args="$build_args --notes \"$notes\""
printf '%s\n%s\n' "$key" "$password" | ssh -o BatchMode=yes -o ServerAliveInterval=30 "$HOST" \
  "cd /d $REMOTE_DIR_WIN && node scripts\\release-desktop.mjs build --secrets-stdin $build_args"

mkdir -p "$dest"
find "$dest" -maxdepth 1 -name 'Canvink_*_x64-setup.exe' -delete
scp -q -o BatchMode=yes "$HOST:$REMOTE_DIR_SCP/public/download/*" "$dest/"
echo "Done: $version in $dest. Commit the version bump, then deploy the web app."
