// Maple Self Hosted — Bun + Elysia server skeleton.
//
// Scope per docs/spec/12-maple-apps-spec.md § 07:
//   - Serve the Maple Hosted browser UI (same WASM client).
//   - Provide real filesystem access (read/write XMP sidecars, .maple/ cache).
//   - Persist a non-authoritative library index in MongoDB.
//   - Run an Indexer worker for background thumb / EXIF / face-detection.
//   - WebAuthn/passkey auth (Phase 5 per spec).
//
// Current state: stub only. The HTTP server starts and answers /health.
// Everything else — routes, MongoDB wiring, Indexer queue, Angular-UI
// static hosting — is documented in the slice 10b implementation plan.
//
// Run:   bun src/index.ts

import { Elysia } from "elysia";

const PORT = Number(process.env.PORT ?? 3000);

const app = new Elysia()
  .get("/health", () => ({ ok: true, product: "maple-self-hosted", version: "0.1.0" }))
  .get("/", () =>
    "Maple Self Hosted — stub. See docs/superpowers/plans/2026-04-22-slice-10b-maple-self-hosted.md"
  )
  .listen(PORT);

console.log(`Maple Self Hosted listening on http://localhost:${PORT}`);
console.log("This is a slice-10b scaffold. Real routes + MongoDB + Indexer still to build.");
