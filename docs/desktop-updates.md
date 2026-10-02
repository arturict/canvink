# Desktop updates

Hostnames under `example.com` in this document are configuration examples.
Replace them with the deployment origins; they do not describe a live service.

The desktop app (Tauri 2, WebView2) bundles the web build, so it does not pick
up a web deploy by itself. Since 0.3.1 it updates itself:

1. On start and then every 30 minutes it reads
   `https://canvink.example.com/download/latest.json` (the web Worker serves it
   from `public/download/`, with `max-age=0, must-revalidate` in
   `public/_headers`).
2. A newer version shows a small "Update verfügbar" button next to the account
   and sync icon. A click downloads the signed installer in the background
   ("Wird geladen… 42 %").
3. "Neu starten" flushes queued ink, the storage runtime and a sync, then runs
   the NSIS installer in passive mode and reopens the app. If the flush fails
   or hangs for more than 5 seconds the update goes ahead anyway; the ink
   journal and the local outbox keep what was not written.

A failed download or install shows "Update fehlgeschlagen"; a click retries it.
The browser build never loads the updater code.

Builds before 0.3.1 have no updater and need one manual install.

## Release in one command

On Linux, from the checkout whose `public/download/` the web deploy uses:

```sh
pnpm release:desktop              # next patch version
pnpm release:desktop minor        # or 1.2.3, or --keep-version
```

`scripts/release-desktop.sh` bumps the version (`package.json`,
`src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.lock`),
sends the working tree to the Windows desktop, builds and signs the NSIS
installer there with `scripts/release-desktop.mjs build`, and copies
`Canvink_<version>_x64-setup.exe`, `Canvink_x64-setup.exe` (the download button)
and `latest.json` back into `public/download/`. Then commit the version bump and
deploy the web app (`pnpm build && wrangler deploy`). The script deploys and
pushes nothing. The installers and `latest.json` are gitignored.

The desktop must be on. The script never powers it down.

## Signing key

Updates are verified with a minisign-style key pair, not with Windows code
signing. The public key is `plugins.updater.pubkey` in
`src-tauri/tauri.conf.json`. The private key and its password are in the
1Password `agent` vault, item "Canvink Tauri updater signing key". The release
script fetches them with `op` and hands them to the build as
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never
commit them. Losing the key means no installed app can be updated again; a new
key needs a manual install of a build that carries the new public key.

The updater bundle (`createUpdaterArtifacts`, which needs the key) is switched on
only by the overlay `src-tauri/tauri.updater.conf.json` that the release script
passes with `--config`, so `pnpm tauri:build:windows` and other builds work
without the key. Updater builds from CI would need the key as a secret.

Building by hand on Windows: set both variables (or sign in to `op`), then
`node scripts/release-desktop.mjs build`.

## Not covered

The installer is not Authenticode-signed, so Windows SmartScreen asks for
confirmation on the first manual install. `src-tauri/tauri.signing.conf.json`
is that separate, optional signing setup (`docs/windows-code-signing.md`) and
is not used by the update flow. Updates downloaded by the app are checked
against the updater key and do not go through SmartScreen.
