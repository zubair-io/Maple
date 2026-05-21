# Slice 10b — Maple Self Hosted (Bun + MongoDB + Indexer)

**Goal:** Deliver a self-hostable Maple server — Bun/Elysia backend, MongoDB for the library index, an Indexer worker for background thumbnailing / EXIF / face detection, and static hosting of the Maple Hosted browser UI. Provides real filesystem access, writes XMPs and `.maple/` thumbs back to disk.

**Current state:** Scaffold at `src/maple-self-hosted/` — `bun src/index.ts` starts a stub Elysia server with a `/health` route. Nothing else.

**Spec pointers:**
- `docs/spec/12-maple-apps-spec.md` § 07 (Maple Self Hosted).
- `docs/spec/12-maple-apps-spec.md` § 08 (Indexer subsystem).
- `docs/spec/00-overview.md` "Server (Bun/TypeScript, design phase)".

## Architecture

```
                ┌─────────────────────────────────────┐
                │        Maple Hosted UI (Angular)     │
                │         served from /                │
                └─────────────────────────────────────┘
                                 │
                ┌─────────────────┴───────────────────┐
                │           Elysia HTTP server         │
                │   /api/folders   /api/assets/:id     │
                │   /api/xmp/:id   /api/thumbs/:id     │
                └─────────────────┬───────────────────┘
                                  │
           ┌──────────────────────┼────────────────────────┐
           │                      │                        │
     ┌─────▼──────┐        ┌──────▼──────┐         ┌──────▼──────┐
     │ MongoDB    │        │ Indexer     │         │ FS access   │
     │ library    │        │ worker      │         │ read/write  │
     │ index      │        │ queue       │         │ .maple/ + XMP│
     └────────────┘        └─────────────┘         └─────────────┘
                                  │
                          ┌───────┴───────┐
                          │ raw-ffi via   │
                          │ Bun.dlopen()  │
                          └───────────────┘
```

MongoDB is cache, sidecars are authoritative (spec § 00 principle 1: "No catalog").

## Phases

### P1 — MongoDB schema + driver wiring (~3 days)
- Collections: `folders` (id, path, last_scan, file_count), `assets` (id, folder_id, filename, size, mtime, rating, flag, color_label, thumb_hash), `users` (Phase 5 auth).
- Driver: `mongodb` from npm (official), typed via `@types/bun`.
- Connection config via env: `MAPLE_MONGO_URI`, `MAPLE_MONGO_DB`.
- Migration script for initial indexes (`(folder_id, filename)` unique, `mtime` sparse).

### P2 — Elysia HTTP routes (~1 week)
- `GET /api/folders` — list registered folders.
- `POST /api/folders` — register a new folder (triggers indexer scan).
- `GET /api/folders/:id/assets` — paged asset list for a folder.
- `GET /api/assets/:id` — single asset metadata.
- `GET /api/assets/:id/raw` — binary RAW bytes (streaming).
- `GET /api/assets/:id/thumb?size=NxN` — thumbnail from the `.maple/` cache.
- `GET /api/assets/:id/xmp` / `PUT /api/assets/:id/xmp` — sidecar read/write.
- `GET /api/health` — already stubbed.
- CORS config for Maple Hosted dev origin.

### P3 — Filesystem layer (~3 days)
- Chroot-like path restriction: server only reads/writes under configured roots.
- Atomic XMP writes via temp-file + rename.
- `.maple/` directory management: create if missing, per-folder.
- File-change watcher (optional: notify UI of external changes).

### P4 — Indexer worker subsystem (~1 week)
- Queue: in-memory + persistent-backup (MongoDB collection).
- Tasks: thumbnail generation (via `raw-ffi` called through Bun's `dlopen`), EXIF extraction, optional face detection (defer unless demanded).
- Concurrency control: configurable worker count; backpressure on slow disks.
- Progress reporting via Server-Sent Events or WebSocket channel to the UI.

### P5 — `raw-ffi` integration via Bun FFI (~3 days)
- **Blocker:** xcframework is for Apple; Bun needs a `libraw_ffi.so` / `.dylib`. Build script needs cargo target `x86_64-unknown-linux-gnu` / `aarch64-apple-darwin` → shared library. Not xcframework.
- Add a `scripts/build-raw-ffi.sh` that produces the shared lib for the current platform and drops it in `src/maple-self-hosted/native/`.
- Bun side: `const lib = dlopen('./native/libraw_ffi.so', { maple_render_file: { args: [...], returns: ... } })`.
- Wrapper TS functions that marshal bytes + free buffers.

### P6 — Static UI serving (~2 days)
- Bundle Maple Hosted (slice 10a) into the Bun server's static dir.
- Route: `GET /` serves `index.html`; `GET /assets/*` serves bundle.
- Development mode: proxy to Angular dev server.

### P7 — WebAuthn / passkey auth (Phase 5; defer)
- Per spec § 00 "deferred to Phase 5". Not in 10b MVP.
- Scaffold only: routes at `/api/auth/register`, `/api/auth/verify`; no enforcement.

### P8 — Packaging + docs (~2 days)
- Dockerfile with Bun + MongoDB (single container or compose).
- README with self-host setup instructions.
- Systemd unit file example.

## Deliverables

- Bun server runnable locally via `bun src/index.ts` with a MongoDB env pointer.
- Angular UI served on the same origin; folder pickers write back to real disk.
- Indexer generates thumbs on folder-add, serves them back from `.maple/`.
- Docker image you can `docker run` on any Linux host.

## Open questions

- **RAW processing on the server vs. pass-through to client.** Currently the Bun server needs `raw-ffi` to generate thumbs. Should full-resolution renders also happen server-side? Probably no (WASM on client is fine for editing; server is just for the indexer).
- **Concurrency model for large imports.** 10,000-photo folders: batch-insert strategy, memory ceiling on the indexer queue.
- **Auth scope.** Multi-user? Single-user with passkey? Spec is ambiguous; likely single-user for v1 Self Hosted.

## Estimated total: 3-4 weeks for a single engineer.
