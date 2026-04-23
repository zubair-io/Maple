# Maple Self Hosted

Bun backend + MongoDB + Indexer + browser UI (same WASM client as Maple Hosted). Spec: `docs/spec/12-maple-apps-spec.md` § 07.

## Current state (2026-04-22)

Scaffold only. `bun src/index.ts` starts an Elysia server that responds on `/health`. Everything else is documented in the slice 10b plan.

## What's built

- `package.json` pinning Elysia + MongoDB driver, Bun scripts (`dev`, `start`, `indexer`).
- `src/index.ts` — minimal Elysia HTTP server with a `/health` route.
- `tsconfig.json` — strict TS with Bun types.

## What's NOT built (see slice 10b plan)

- MongoDB schema (`assets`, `folders`, `users` collections per spec § 07).
- HTTP routes for folder enumeration, asset fetch, XMP read/write, thumb serve.
- Indexer worker: background thumbnail generation, EXIF extraction, optional face detection.
- Static file serving for the Maple Hosted UI bundle.
- WebAuthn/passkey auth (deferred to Phase 5 per spec § 00).
- The `.maple/` folder cache I/O shim (reads/writes thumbs and previews on behalf of browser clients that don't have filesystem access).
- `raw-ffi` staticlib integration via bun's FFI for server-side RAW render (for thumbnail generation in the Indexer).

## Run the stub

```bash
cd /Users/riabuz/Projects/_Maple/src/maple-self-hosted
bun install
bun src/index.ts
# curl http://localhost:3000/health
```

## Implementation plan

See `docs/superpowers/plans/2026-04-22-slice-10b-maple-self-hosted.md`.
