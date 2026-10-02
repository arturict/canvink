#!/usr/bin/env bash
# One command for the Android app, run from a Linux checkout of Canvink:
#
#   scripts/release-android.sh [--bump patch|minor|x.y.z] [--dest DIR]
#
# It builds the signed release APKs (arm64 for phones, x86_64 for emulators)
# and writes the phone APK and `android.json` into DEST (default:
# public/download of this checkout) and uploads the APK to the R2 bucket
# canvink-downloads, which serves /download/Canvink.apk. The web deploy then
# publishes android.json. The
# app compares `android.json` with its own version and offers the APK as an
# update (src-tauri/src/android_update.rs). Nothing is deployed or pushed.
#
# Needs the Android SDK (ANDROID_HOME, default ~/Android/Sdk) with an NDK,
# a JDK, and the Rust targets aarch64-linux-android and x86_64-linux-android.
# The release keystore comes from the 1Password item "Canvink Android release
# keystore" (document plus password) into a git-ignored file for the build; it
# is removed afterwards. Nothing secret is printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_HOME
NDK_HOME="${NDK_HOME:-$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n1)}"
[ -n "$NDK_HOME" ] || { echo "No NDK under $ANDROID_HOME/ndk (sdkmanager \"ndk;27.2.12479018\")" >&2; exit 1; }
export NDK_HOME

ITEM="Canvink Android release keystore"
GEN="$ROOT/src-tauri/gen/android"
dest="$ROOT/public/download"
bump=""
upload=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) dest="$2"; shift 2 ;;
    --bump) bump="$2"; shift 2 ;;
    --no-upload) upload=0; shift ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done

if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] && [ -r "$HOME/.config/op/service-token" ]; then
  OP_SERVICE_ACCOUNT_TOKEN="$(cat "$HOME/.config/op/service-token")"
  export OP_SERVICE_ACCOUNT_TOKEN
fi

work="$(mktemp -d)"
cleanup() { rm -rf "$work"; rm -f "$GEN/keystore.properties"; }
trap cleanup EXIT
umask 077

op document get "$ITEM" --vault agent --out-file "$work/release.jks" >/dev/null
printf 'storeFile=%s\nkeyAlias=canvink\nstorePassword=%s\nkeyPassword=%s\n' \
  "$work/release.jks" "$(op read "op://agent/$ITEM/password")" "$(op read "op://agent/$ITEM/password")" \
  > "$GEN/keystore.properties"

# OpenSSL (built from source for the Android HTTP client) looks for
# <triple>-ranlib and <triple>-ar, which the NDK ships under llvm- names.
bin="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
mkdir -p "$work/shim"
for triple in aarch64-linux-android x86_64-linux-android; do
  ln -s "$bin/llvm-ranlib" "$work/shim/$triple-ranlib"
  ln -s "$bin/llvm-ar" "$work/shim/$triple-ar"
done
export PATH="$work/shim:$PATH"

if [ -n "$bump" ]; then
  version="$(node scripts/release-desktop.mjs bump "$bump")"
else
  version="$(node -p "require('./package.json').version")"
fi
echo "Building Canvink Android $version"

# One target at a time with few compiler jobs: two parallel release builds of
# the whole dependency tree ran a 15 GB machine out of memory.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
for target in aarch64 x86_64; do
  pnpm tauri android build --apk --split-per-abi --target "$target" --ci
done

# Cargo rewrites Cargo.lock while it builds and drops release-please's marker
# comment; put it back so the desktop release tooling still finds it.
sed -i '/^name = "canvink"$/{n;s/^\(version = "[^"]*"\)$/\1 # x-release-please-version/}' src-tauri/Cargo.lock

out="$GEN/app/build/outputs/apk"
phone="$(find "$out" -name 'app-arm64-release.apk' | head -n1)"
emulator="$(find "$out" -name 'app-x86_64-release.apk' | head -n1)"
[ -n "$phone" ] && [ -n "$emulator" ] || { echo "Release APKs not found under $out (unsigned build?)" >&2; exit 1; }

apksigner="$(find "$ANDROID_HOME/build-tools" -name apksigner | sort -V | tail -n1)"
"$apksigner" verify --min-sdk-version 24 "$phone"
"$apksigner" verify --min-sdk-version 24 "$emulator"

mkdir -p "$dest"
cp "$phone" "$dest/Canvink.apk"
chmod 644 "$dest/Canvink.apk"
cp "$emulator" "$ROOT/src-tauri/target/Canvink-x86_64.apk"
sha="$(sha256sum "$dest/Canvink.apk" | cut -d' ' -f1)"
size="$(stat -c %s "$dest/Canvink.apk")"
printf '{\n  "version": "%s",\n  "sha256": "%s",\n  "size": %s,\n  "built": "%s"\n}\n' \
  "$version" "$sha" "$size" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dest/android.json"
chmod 644 "$dest/android.json"
# Workers static assets stop at 25 MiB, so the APK is served from R2 by
# web-worker/index.ts; upload it now so it matches android.json once the web
# app is deployed. --no-upload skips this (for a local test build).
if [ "$upload" = 1 ]; then
  "$ROOT/services/collab-sync/node_modules/.bin/wrangler" r2 object put canvink-downloads/Canvink.apk \
    --file "$dest/Canvink.apk" --content-type application/vnd.android.package-archive --remote >/dev/null
fi
echo "Done: $version, $((size / 1024 / 1024)) MB in $dest/Canvink.apk (emulator build: src-tauri/target/Canvink-x86_64.apk)."
echo "Commit the version bump (if any), then deploy the web app."
