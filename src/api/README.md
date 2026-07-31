# Maple Self Hosted

Bun + Elysia backend with MongoDB library index, background Indexer, raw-ffi thumbnail generation, and the same Angular WASM client as Maple Hosted — all self-hostable on your own hardware.

Spec: `docs/spec/12-maple-apps-spec.md` § 07–08.

## Quick start (local development)

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- [Docker](https://www.docker.com) (for MongoDB)
- Node / npm (only needed to rebuild the Angular UI)

### 1. Start MongoDB

```bash
cd src/api
docker compose up -d mongo
```

This starts MongoDB on `localhost:27017`. Data is persisted in the `mongo_data` Docker volume.

### 2. (Optional) Build the native RAW thumbnail library

Required for thumbnail generation from RAW files (`.dng`, `.cr2`, etc.):

```bash
./scripts/build-raw-ffi.sh
```

This compiles `libraw_ffi.dylib` (macOS) and places it in `native/`. Without it, the server starts fine but skips RAW thumbnail generation.

### 3. Install dependencies and start the server

```bash
bun install
bun src/index.ts
```

The server listens on `http://localhost:3000`. The Angular UI is served from `/`. The
static-UI handler resolves the bundle at `src/web/dist/maple/browser/` — build with
`cd src/web && npm run build:maple` (or `ng build maple --configuration=production`).

### 4. Pick a library folder in the UI

Open `http://localhost:3000`. On first run, the empty browse shell shows a
**library picker** — navigate to your photos folder (or any subdirectory of
your Docker mount) and click "Use this folder". The Indexer starts scanning
in the background.

(For scripted setup you can still POST to `/api/folders` directly:
`curl -X POST http://localhost:3000/api/folders -H 'Content-Type: application/json' -d '{"path":"/photos"}'`.)

## Environment variables

| Variable                | Default                                                                  | Description                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `3000`                                                                   | HTTP listen port                                                                                                                                                                                    |
| `MAPLE_MONGO_URI`       | `mongodb://localhost:27017`                                              | MongoDB connection string                                                                                                                                                                           |
| `MAPLE_MONGO_DB`        | `maple`                                                                  | MongoDB database name                                                                                                                                                                               |
| `MAPLE_ROOTS`           | `/`                                                                      | Colon-separated FS roots the server may browse and read. Defaults to `/` (Docker mount is the jail).                                                                                                |
| `MAPLE_INDEXER_WORKERS` | `2`                                                                      | Concurrent indexer worker threads                                                                                                                                                                   |
| `MAPLE_DEV`             | (none)                                                                   | Set to `1` to proxy UI to Angular dev server                                                                                                                                                        |
| `MAPLE_DEV_ORIGIN`      | `http://localhost:4201`                                                  | Angular dev server origin when `MAPLE_DEV=1` (the `maple` app serves on 4201)                                                                                                                       |
| `MAPLE_UI_DIST`         | (auto-resolved)                                                          | Override the Angular bundle dist path                                                                                                                                                               |
| `MAPLE_RP_ID`           | `localhost`                                                              | **WebAuthn Relying Party ID — set to your bare hostname in production** (`maple.example.com`, no scheme/port). The browser rejects passkey ceremonies whose `rpId` doesn't match the page hostname. |
| `MAPLE_ORIGIN`          | `http://localhost:3000,http://localhost:4200,http://localhost:4201`      | **Set to your full public origin in production** (`https://maple.example.com`). Comma-separated for multiple. Used to verify WebAuthn assertions came from the expected origin.                     |
| `MAPLE_CORS_ORIGIN`     | `*`                                                                      | CORS `Access-Control-Allow-Origin`. Tighten to your domain in production.                                                                                                                           |
| `MAPLE_JWT_SECRET_FILE` | `./.maple/jwt.secret` (native) · `/app/config/jwt.secret` (Docker image) | On-disk **fallback** secret path, used only when MongoDB is unreachable at boot.                                                                                                                    |
| `MAPLE_DEV_AUTH`        | (none)                                                                   | Set to `1` to expose `/api/auth/dev-login` (passkey bypass). **NEVER set in production.**                                                                                                           |
| `MAPLE_TLS_CERT`        | (none)                                                                   | Absolute path to a TLS certificate. Set together with `MAPLE_TLS_KEY` to serve HTTPS instead of plain HTTP — see "TLS on the LAN" below. Setting only one of the pair, or an unreadable path, fails startup with a clear error rather than silently falling back to HTTP. |
| `MAPLE_TLS_KEY`         | (none)                                                                   | Absolute path to the TLS certificate's private key. See `MAPLE_TLS_CERT`.                                                                                                                           |

**JWT secret resolution.** The HS256 signing secret is owned by the server — there is no environment variable to set it. It is resolved at startup in this order: (1) the **database** — collection `server_state`, document `_id: "jwt_secret"`, field `value`, created once on first boot; this is the canonical store because MongoDB data persists across container recreates and is shared by every instance, so the secret never silently rotates; (2) `MAPLE_JWT_SECRET_FILE` on disk, a degraded fallback used only when Mongo is unreachable; (3) an in-memory secret as a last resort if the filesystem is unusable (it won't survive a restart). The startup log line `JWT secret resolved` reports the `source` (`db`/`db-created`/`file`/`generated`/`memory`) and a non-reversible `fingerprint` — a changing fingerprint across restarts/instances is the signature of a `bad signature` auth bug.

## API reference

```
GET  /api/health                    — server liveness + DB status
GET  /api/folders                   — list registered library folders
POST /api/folders                   — register a folder (triggers background scan)
GET  /api/folders/:id/assets        — paged asset list (?page=1&limit=100)
GET  /api/assets/:id                — single asset metadata
GET  /api/assets/:id/raw            — stream raw file bytes
GET  /api/assets/:id/thumb?size=NxN — thumbnail from .maple/ cache
GET  /api/assets/:id/xmp            — read XMP sidecar
PUT  /api/assets/:id/xmp            — write XMP sidecar (atomic)
GET  /api/indexer/stats             — queue stats
GET  /api/indexer/progress          — SSE stream of indexer progress
GET  /api/auth/status               — auth status (Phase 5: always authenticated)
POST /api/auth/register             — WebAuthn registration (Phase 5: returns 501)
POST /api/auth/verify               — WebAuthn verify (Phase 5: returns 501)
GET  /api/fs/list?path=<abs>&showAll=0|1   — list subdirectories under <abs> (library picker)
GET  /                              — Angular SPA (SPA fallback for all non-API routes)
```

The full machine-readable contract is available at `GET /openapi.json` when running `bun run dev` in `src/api/` (issue #131). A human-readable Scalar UI for the same spec is served at `GET /docs`. Both endpoints are unauthenticated so client codegen tooling can fetch the spec without a bearer token.

## Development mode (UI hot-reload)

One command starts MongoDB, the Bun API in proxy-to-`ng serve` mode, and the
Angular dev server:

```bash
bash src/scripts/dev-self-hosted.sh
# or, from src/api/
bun run dev:all
```

Open http://localhost:3000 — the API serves the SPA and proxies non-`/api`
routes to `ng serve` on `:4201` so HMR works through one URL. Ctrl-C stops
the API and dev server (Mongo keeps running; stop it with
`docker compose down`).

If you'd rather start the pieces individually:

```bash
# Terminal 1: start Angular dev server for the Self-Hosted app
cd src/web && npx ng serve maple --port 4201

# Terminal 2: start Bun backend in dev mode (proxies to ng serve on 4201)
cd src/api && MAPLE_DEV=1 bun src/index.ts
```

## Self-hosting with Docker Compose

```bash
cd src/api

# Start MongoDB + Maple server
docker compose --profile app up -d

# View logs
docker compose logs -f maple
```

Edit `docker-compose.yml` to mount your photo library:

```yaml
volumes:
  - /path/to/your/photos:/photos:rw
environment:
  MAPLE_ROOTS: /photos
```

The JWT signing secret is stored in MongoDB and shared across instances, so it
survives `docker compose up --build` / redeploys without extra configuration —
see "JWT secret resolution" above. The `maple_config` volume (mounted at
`/app/config`) only holds the on-disk fallback secret used when Mongo is
unreachable at boot; keeping the mount means even that degraded path stays
stable.

## TLS on the LAN (enabling GPU rendering)

Chrome (and every other evergreen browser) only exposes `navigator.gpu` on a
**secure context** — `https:`, or exactly `http://localhost`. A self-hosted
server reached over its LAN IP (`http://192.168.1.42:3000`) is neither, so
the editor's live GPU render path is unavailable there: it silently falls
back to the slower WASM-CPU/2D path, and the app shows a dismissible notice
pointing back at this section.

Set `MAPLE_TLS_CERT` + `MAPLE_TLS_KEY` (both, as absolute paths to a
certificate and its private key) to have the server terminate TLS itself and
restore the secure context on the LAN origin too:

```bash
# mkcert (recommended for LAN use — trusted by browsers on the machine that
# ran `mkcert -install`, no browser security-exception click-through):
brew install mkcert    # or your platform's package manager
mkcert -install
mkcert -cert-file /opt/maple/tls/cert.pem -key-file /opt/maple/tls/key.pem \
  192.168.1.42 maple.local localhost 127.0.0.1

MAPLE_TLS_CERT=/opt/maple/tls/cert.pem \
MAPLE_TLS_KEY=/opt/maple/tls/key.pem \
bun src/index.ts
```

A plain self-signed cert (`openssl req -x509 -newkey rsa:2048 -nodes ...`)
works too, but browsers show a security-exception interstitial for it on
every device that connects — `mkcert` avoids that by installing a local CA
the browser already trusts.

Both variables must be set together — the server fails fast at startup
(before it accepts any connection) if only one is set, or if either path
isn't a readable file, rather than silently continuing to serve the exact
insecure origin this is meant to fix. `GET /api/network/local-address`
(consumed by the LAN-switch banner and the Apple client) advertises
`scheme: "https"` automatically once TLS is active, so clients build the
correct candidate origin without any extra configuration.

Deploying behind a reverse proxy or tunnel that already terminates TLS in
front of the Bun process (a public HTTPS domain via Cloudflare Tunnel,
nginx, Caddy, etc.)? Leave `MAPLE_TLS_CERT`/`MAPLE_TLS_KEY` unset — that path
is unrelated to this section, which is specifically about the *direct* LAN
origin the Bun process itself listens on.

## Self-hosting on Linux (systemd)

1. Build the project and copy files to `/opt/maple/`.
2. Build the native library on Linux:
   ```bash
   cargo build --release -p raw-ffi
   cp target/release/libraw_ffi.so /opt/maple/native/
   ```
3. Copy the systemd unit:
   ```bash
   sudo cp maple.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now maple
   ```
4. Edit `/etc/systemd/system/maple.service` to set `MAPLE_ROOTS` and photo paths.

See `maple.service` for the full unit file.

## Architecture

```
Browser (Angular SPA)
    │
    ▼
Elysia HTTP server (Bun)
    ├── /api/folders, /api/assets  ← MongoDB (library index, non-authoritative)
    ├── /api/assets/:id/raw         ← direct filesystem read
    ├── /api/assets/:id/thumb       ← .maple/ cache on disk
    ├── /api/assets/:id/xmp         ← XMP sidecar read/write (atomic)
    ├── /api/indexer/progress       ← SSE stream
    └── /*                          ← Angular bundle (SPA fallback)

Indexer (in-process, EventEmitter-based queue)
    ├── scan_folder → walk dir tree, upsert MongoDB records
    ├── gen_thumb   → raw-ffi (libraw_ffi.dylib) → .maple/thumbs/
    └── extract_exif → parse XMP sidecar → update MongoDB
```

**MongoDB is cache; sidecars (`.xmp`) are authoritative.** Deleting MongoDB and re-scanning will reproduce the index.

## Testing

```bash
bun test                # run all tests (no MongoDB required)
bun run typecheck       # TypeScript strict check
```

## Known limitations and deferrals

- **WebAuthn auth**: deferred to Phase 5 per spec § 00. No auth is enforced in this build.
- **Full-res RAW render**: the client-side WASM handles editing; the server only generates thumbnails.
- **Linux native library**: requires a native Linux build or `cross` (Docker). See `scripts/build-raw-ffi.sh`.
- **JPEG resize**: non-RAW thumbnail resize uses a BMP passthrough placeholder. TODO: integrate sharp.
- **Face detection**: deferred beyond MVP.
