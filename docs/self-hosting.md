# Self-hosting Canvink

Canvink's hosted web build is a static, local-first browser application. The
container serves HTML, JavaScript, CSS, and other static assets. It does not
receive, store, sync, or back up notebook data.

## Security and durability boundary

The default Compose configuration binds only to `127.0.0.1`. Keep that default
for use on one machine. To serve other users, put an HTTPS reverse proxy in
front of this localhost listener. Do not expose the container port directly to
the public internet.

The runtime image:

- runs nginx as UID and GID `101`, not root;
- runs with all Linux capabilities dropped and `no-new-privileges`;
- has a read-only root filesystem and a small `/tmp` tmpfs;
- provides `GET /healthz` on container port `8080`;
- returns the same restrictive browser security headers as the hosted build;
- uses immutable caching only for Vite's content-hashed `/assets/` files;
- disables storage for `index.html`, `version.json`, and possible service-worker
  entry points so upgrades do not strand an old application shell.

The production browser build registers a same-origin service worker on HTTPS or
localhost. After one successful load and worker activation, the cached
application shell can reopen offline and load the last successful workspace
save from IndexedDB. A first visit still needs the server. The cache does not
contain notebook content and is not sync, backup, or crash recovery.

## Requirements

- Docker Engine 24 or newer with Docker Compose v2
- enough memory to build the Vite application
- an HTTPS-capable reverse proxy for any non-local deployment

The Dockerfile pins Node, pnpm, nginx, and both base-image manifest digests.
Updating those pins is an explicit dependency update and should be followed by
the validation steps below.

## Build and start

From the repository root, start the localhost-only service. Without an explicit
build argument, `version.json` honestly labels the source as `self-hosted`:

```powershell
docker compose build --pull
docker compose up -d
```

To record an exact Git commit, first require a clean worktree. Never label a
dirty build with its unchanged HEAD SHA:

```powershell
if (git status --porcelain) { throw 'Commit provenance requires a clean worktree.' }
$env:CANVINK_COMMIT = git rev-parse HEAD
docker compose build --pull
```

For a POSIX shell, the equivalent clean-source build is:

```sh
test -z "$(git status --porcelain)" || { echo 'Commit provenance requires a clean worktree.' >&2; exit 1; }
CANVINK_COMMIT="$(git rev-parse HEAD)" docker compose build --pull
docker compose up -d
```

Open `http://127.0.0.1:8080/app`. The landing page is available at
`http://127.0.0.1:8080/`.

To use another localhost port without changing the container:

```powershell
$env:CANVINK_PORT = '8090'
docker compose up -d
```

Check the service:

```powershell
docker compose ps
Invoke-WebRequest http://127.0.0.1:8080/healthz
Invoke-RestMethod http://127.0.0.1:8080/version.json
```

`/healthz` confirms that nginx can answer requests. It does not prove browser
storage, editing, imports, exports, or data recovery. Test those flows in a
real browser after every upgrade.

## Browser data model

The web app keeps one logical `WorkspaceState` schema-v1 snapshot under the
namespace `canvink:workspace:v1` through the `idb-keyval` IndexedDB adapter. The
snapshot contains notebooks, sections, pages, page elements, the trash, and
active-selection identifiers. Image and PDF previews are data URLs inside that
snapshot, so they can make exports large. The physical IndexedDB database and
object-store names are implementation details, not a supported backup API.

The optional guide and text-size settings use the localStorage key
`canvink:ui-preferences:v1`. They are not required to restore notebook data.

IndexedDB is partitioned by scheme, hostname, port, browser profile, and browser
storage policy. Changing from HTTP to HTTPS, changing a hostname or port, using
a different profile, clearing site data, or an automated browser-retention
policy can expose a new or empty workspace. The container has no volume for
notes because mounting one would not back up browser IndexedDB.

## Backup and restore

Create a portable backup in the app before upgrades and regularly during use:

1. Open `Export`.
2. Choose `Workspace JSON`.
3. Confirm that the downloaded `canvink-workspace-YYYY-MM-DD.json` file exists
   outside the browser's temporary download area.
4. Store copies according to your own encrypted-backup policy.

To restore or move to a different origin:

1. Open the destination `/app` in a current browser.
2. Open `Import` and choose `JSON or Markdown`.
3. Select the Canvink workspace JSON file.
4. Review the replacement warning. Canvink asks for a backup of the current
   destination workspace before replacement.
5. Confirm that expected notebooks and pages are present and that the status
   reaches `Saved locally`.
6. Reload once and verify that the restored workspace returns.

Do not copy nginx container files or Docker volumes as a notebook backup. They
contain only the application build and runtime scratch files.

## HTTPS reverse proxy

Keep Compose bound to localhost and terminate TLS at a maintained reverse
proxy. For example, a Caddy instance on the same host can use:

```caddyfile
notes.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

Point the hostname to the server, restrict the host firewall to the proxy's
HTTP/HTTPS ports, and let the proxy obtain and renew a trusted certificate.
Use one stable HTTPS origin. Moving an existing deployment to another origin
requires users to export and import their JSON backup because browsers do not
move IndexedDB across origins.

If another reverse proxy is used, require HTTPS, preserve the request host,
forward to `127.0.0.1:8080`, set reasonable request and response timeouts, and
keep its TLS implementation patched. Canvink does not provide authentication or
multi-user isolation. Network access to the same static app does not create
shared notebooks or collaboration.

## Upgrade and rollback

Build immutable local tags so the previous image remains available:

```powershell
if (git status --porcelain) { throw 'Commit provenance requires a clean worktree.' }
$commit = git rev-parse HEAD
docker build --pull --build-arg "CANVINK_COMMIT=$commit" -t "canvink:$commit" .
$env:CANVINK_IMAGE = "canvink:$commit"
docker compose up -d --no-build
```

Before switching images:

1. Export and retain a Workspace JSON backup from the exact browser origin.
2. Record the currently running image tag and source commit.
3. Build or pull the new immutable tag without deleting the previous tag.
4. Start the new tag on the same hostname, scheme, and port.
5. Check `/healthz`, `/version.json`, security and cache headers, then exercise
   create, edit, search, export, reload, and restore in a browser.

To roll the static application back, set `CANVINK_IMAGE` to the retained tag and
run `docker compose up -d --no-build` again. A code rollback does not roll back
IndexedDB. Older Canvink builds may not understand data written by a newer data
schema, so do not promise downgrade compatibility. Retain the pre-upgrade JSON
backup and test its compatibility before relying on a rollback.

## Validation

Validate the rendered Compose model and the production image before use:

```powershell
if (git status --porcelain) { throw 'Commit provenance requires a clean worktree.' }
docker compose config --quiet
docker build --pull --build-arg "CANVINK_COMMIT=$(git rev-parse HEAD)" -t canvink:verify .
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m `
  --cap-drop ALL --security-opt no-new-privileges `
  -p 127.0.0.1:18080:8080 canvink:verify
```

In another terminal, verify at minimum:

```powershell
Invoke-WebRequest http://127.0.0.1:18080/healthz
Invoke-WebRequest http://127.0.0.1:18080/app
Invoke-WebRequest http://127.0.0.1:18080/assets/does-not-exist.js -SkipHttpErrorCheck
```

The missing asset must return `404`, `/app` must return the application shell,
and the response headers must include the configured CSP and
`X-Content-Type-Options: nosniff`. Then run the repository's normal lint,
typecheck, unit, build, and browser E2E gates. A healthy container alone is not
release evidence.
