#!/usr/bin/env bun
/**
 * End-to-end smoke test for the PhotoKit backup server endpoints.
 *
 * Runs against a local Maple API server on $MAPLE_API_URL (default
 * http://localhost:3000). Requires MongoDB running on $MAPLE_MONGO_URI.
 *
 * Prerequisites:
 *   1. MongoDB running:  docker compose up -d mongo  (from src/api/)
 *   2. API server running:  cd src/api && bun run dev
 *
 * Usage:
 *   bun src/scripts/test_backup_smoke.ts
 *   # or, after chmod +x:
 *   src/scripts/test_backup_smoke.ts
 *
 * Environment variables:
 *   MAPLE_API_URL   — API base URL (default: http://localhost:3000)
 *   MAPLE_MONGO_URI — MongoDB connection string (default: mongodb://localhost:27017)
 *   MAPLE_MONGO_DB  — MongoDB database name (default: maple)
 *
 * Exit code:
 *   0 — all steps passed
 *   non-zero — a step failed (the failing step is printed to stderr)
 *
 * What it tests:
 *   Step 1 — Create a library folder (direct Mongo insert; /api/folders is auth-gated)
 *   Step 2 — Seed a geocode_cache entry for Tokyo so the path-formatter gets a location name
 *   Step 3 — Upload a 1024-byte "RAW" in two chunks via POST /api/libraries/:id/backup/ingest
 *   Step 4 — Verify the assembled file landed on disk at the expected location
 *   Step 5 — Upload an XMP sidecar via POST /api/libraries/:id/backup/sidecar
 *   Step 6 — Verify the sidecar file on disk
 *   Step 7 — Upload a rendered companion (single chunk) via POST /api/libraries/:id/backup/rendered
 *   Step 8 — Verify the rendered companion on disk
 *   Step 9 — Fetch the reconciliation feed via GET /api/libraries/:id/backup/state
 *   Step 10 — Mark the asset deleted via POST /api/libraries/:id/backup/notify-deleted
 *   Step 11 — Assert deleted_from_photos=true in MongoDB
 *   Step 12 — Cleanup: remove test data from disk and all three collections
 */

import { MongoClient, ObjectId } from "mongodb";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = process.env.MAPLE_API_URL ?? "http://localhost:3000";
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? "mongodb://localhost:27017";
const MONGO_DB = process.env.MAPLE_MONGO_DB ?? "maple";

// Use the PID to avoid collisions when the test is run concurrently.
const DEVICE_ID = `smoke-test-device-${process.pid}`;
const PHID = `smoke/${process.pid}/IMG_0001`;
// A deterministic BLAKE3-shaped hex string (the server treats it as opaque).
const MAPLE_ID = `smoke${process.pid.toString(16).padStart(10, "0")}deadbeef12345678`;

// Tokyo, 2024-03-15.
const LAT = "35.68";
const LON = "139.69";
// Quantised cache key (4 decimal places — matches quantizedKey() in coordinate-cache.ts).
const GEO_CACHE_KEY = `lat:35.68,lon:139.69`;
const CAPTURE_DATE = "2024-03-15T10:30:00Z";
const FILENAME = "IMG_0001.HEIC";

// Expected relative path under the library, derived from path-formatter.ts logic:
//   With location: <year>/<location>/<MM>-<DD>/<filename>
//   → 2024/Tokyo/03-15/IMG_0001.HEIC
const EXPECTED_REL_PATH = `2024/Tokyo/03-15/${FILENAME}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pass(msg: string): void {
  console.log(`  PASS  ${msg}`);
}

function fail(msg: string, detail?: string): never {
  console.error(`  FAIL  ${msg}${detail ? `\n        ${detail}` : ""}`);
  process.exit(1);
}

async function assertStatus(
  resp: Response,
  expected: number,
  label: string,
): Promise<void> {
  if (resp.status !== expected) {
    const body = await resp.text().catch(() => "(unreadable body)");
    fail(`${label}: expected HTTP ${expected}, got ${resp.status}`, body);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n  Maple PhotoKit backup — end-to-end smoke test");
  console.log(`  API:   ${API}`);
  console.log(`  Mongo: ${MONGO_URI}/${MONGO_DB}`);
  console.log(`  PID:   ${process.pid}`);
  console.log(`  PHID:  ${PHID}`);
  console.log("");

  // ── MongoDB connection ───────────────────────────────────────────────────
  const mongo = new MongoClient(MONGO_URI, {
    connectTimeoutMS: 5000,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await mongo.connect();
  } catch (e: any) {
    fail("MongoDB unreachable — start it with: docker compose up -d mongo", e?.message);
  }
  const db = mongo.db(MONGO_DB);
  const foldersColl = db.collection("folders");
  const assetsColl = db.collection("assets");
  const geocodeColl = db.collection("geocode_cache");
  const uploadSessionsColl = db.collection("upload_sessions");
  const backupSessionsColl = db.collection("backup_sessions");

  // ── Healthcheck ──────────────────────────────────────────────────────────
  try {
    const hc = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!hc.ok) throw new Error(`status ${hc.status}`);
  } catch (e: any) {
    fail(
      `API server unreachable at ${API} — start it with: cd src/api && bun run dev`,
      e?.message,
    );
  }

  // ── Create temp library folder on disk ──────────────────────────────────
  const libDir = await mkdtemp(join(tmpdir(), "maple-smoke-"));
  console.log(`  Library dir: ${libDir}`);

  // ── Step 1: Register library in MongoDB directly ─────────────────────────
  // /api/folders is behind requireAuth. We seed the folder document directly
  // so the backup routes (which only check foldersCollection) can find it.
  const libraryObjectId = new ObjectId();
  const libraryId = libraryObjectId.toHexString();
  await foldersColl.insertOne({
    _id: libraryObjectId,
    path: libDir,
    label: "smoke-test",
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  });
  pass(`Step 1 — Library seeded in MongoDB (${libraryId})`);

  // ── Step 2: Seed geocode_cache for Tokyo ─────────────────────────────────
  await geocodeColl.deleteOne({ _id: GEO_CACHE_KEY });
  await geocodeColl.insertOne({
    _id: GEO_CACHE_KEY,
    place: {
      source: "nominatim",
      geocoder_version: 1,
      geocoded_at: new Date().toISOString(),
      lat: 35.68,
      lon: 139.69,
      display_name: "Tokyo, Japan",
      address: { city: "Tokyo", country: "Japan", country_code: "jp" },
      pois: [{ name: "Tokyo", category: "place", type: "city" }],
      rollups: { locality: "Tokyo", region: "Tokyo", country_code: "jp" },
      search_blob: "Tokyo Japan",
    },
    fetched_at: new Date(),
    geocoder_version: 1,
  } as any);
  pass("Step 2 — Geocode cache seeded for Tokyo (lat:35.68,lon:139.69)");

  // ── Step 3: Upload in two chunks ─────────────────────────────────────────
  const originalBytes = Buffer.alloc(1024, 0xab);

  // Chunk 1 — bytes 0–511 (intermediate; no X-Maple-Maple-Id)
  const r1 = await fetch(`${API}/api/libraries/${libraryId}/backup/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Maple-Device-Id": DEVICE_ID,
      "X-Maple-Phasset-Id": PHID,
      "X-Maple-Capture-Date": CAPTURE_DATE,
      "X-Maple-Lat": LAT,
      "X-Maple-Lon": LON,
      "X-Maple-Filename": FILENAME,
      "X-Maple-Total-Bytes": "1024",
      "Content-Range": "bytes 0-511/1024",
    },
    body: originalBytes.subarray(0, 512),
  });
  await assertStatus(r1, 202, "ingest chunk 1");
  const body1 = await r1.json() as { next_offset: number };
  if (body1.next_offset !== 512) {
    fail("ingest chunk 1: expected next_offset=512", JSON.stringify(body1));
  }
  pass("Step 3a — Chunk 1 accepted (202, next_offset=512)");

  // Chunk 2 — bytes 512–1023 (final chunk; must include X-Maple-Maple-Id)
  const r2 = await fetch(`${API}/api/libraries/${libraryId}/backup/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Maple-Device-Id": DEVICE_ID,
      "X-Maple-Phasset-Id": PHID,
      "X-Maple-Capture-Date": CAPTURE_DATE,
      "X-Maple-Lat": LAT,
      "X-Maple-Lon": LON,
      "X-Maple-Filename": FILENAME,
      "X-Maple-Total-Bytes": "1024",
      "X-Maple-Maple-Id": MAPLE_ID,
      "Content-Range": "bytes 512-1023/1024",
    },
    body: originalBytes.subarray(512),
  });
  await assertStatus(r2, 200, "ingest chunk 2 (final)");
  const body2 = await r2.json() as { maple_id: string; target_rel_path: string };
  if (body2.maple_id !== MAPLE_ID) {
    fail("ingest final chunk: maple_id mismatch", JSON.stringify(body2));
  }
  if (body2.target_rel_path !== EXPECTED_REL_PATH) {
    fail(
      `ingest final chunk: expected target_rel_path=${EXPECTED_REL_PATH}`,
      `got: ${body2.target_rel_path}`,
    );
  }
  pass(`Step 3b — Final chunk accepted (200), target_rel_path=${body2.target_rel_path}`);

  // ── Step 4: Verify assembled file on disk ────────────────────────────────
  const filePath = join(libDir, body2.target_rel_path);
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(filePath);
  } catch (e: any) {
    fail(`Step 4 — file not found on disk: ${filePath}`, e?.message);
  }
  if (fileStat!.size !== 1024) {
    fail(`Step 4 — file size mismatch: expected 1024, got ${fileStat!.size}`);
  }
  pass(`Step 4 — File on disk (${filePath}, ${fileStat!.size} bytes)`);

  // ── Step 5: Upload XMP sidecar ───────────────────────────────────────────
  const xmpPayload = `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:maple="https://justmaple.app/ns/1.0/"
      maple:phid="${PHID}"
      maple:mapleId="${MAPLE_ID}"/>
  </rdf:RDF>
</x:xmpmeta>`;

  const r3 = await fetch(`${API}/api/libraries/${libraryId}/backup/sidecar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      "X-Maple-Device-Id": DEVICE_ID,
      "X-Maple-Phasset-Id": PHID,
      "X-Maple-Target-Rel-Path": body2.target_rel_path,
    },
    body: xmpPayload,
  });
  await assertStatus(r3, 200, "sidecar upload");
  const sidecarBody = await r3.json() as { target_rel_path: string };
  pass(`Step 5 — Sidecar accepted (200), target_rel_path=${sidecarBody.target_rel_path}`);

  // ── Step 6: Verify sidecar on disk ───────────────────────────────────────
  const sidecarPath = filePath + ".xmp";
  let sidecarContent: string;
  try {
    sidecarContent = await readFile(sidecarPath, "utf8");
  } catch (e: any) {
    fail(`Step 6 — sidecar file not found: ${sidecarPath}`, e?.message);
  }
  if (!sidecarContent!.includes(PHID)) {
    fail(`Step 6 — sidecar content does not contain PHID (${PHID})`);
  }
  pass(`Step 6 — Sidecar on disk (${sidecarPath})`);

  // ── Step 7: Upload rendered companion (single chunk) ─────────────────────
  // The rendered route expects X-Maple-Maple-Id on the final (only) chunk.
  const renderedBytes = Buffer.alloc(512, 0xcd);

  const r4 = await fetch(`${API}/api/libraries/${libraryId}/backup/rendered`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Maple-Device-Id": DEVICE_ID,
      "X-Maple-Phasset-Id": PHID,
      "X-Maple-Target-Rel-Path": body2.target_rel_path,
      "X-Maple-Filename-Ext": "jpg",
      "X-Maple-Total-Bytes": "512",
      "X-Maple-Maple-Id": MAPLE_ID,
      "Content-Range": "bytes 0-511/512",
    },
    body: renderedBytes,
  });
  await assertStatus(r4, 200, "rendered companion upload");
  const renderedBody = await r4.json() as { target_rel_path: string };
  pass(`Step 7 — Rendered companion accepted (200), target_rel_path=${renderedBody.target_rel_path}`);

  // ── Step 8: Verify rendered file on disk ─────────────────────────────────
  const renderedPath = join(libDir, renderedBody.target_rel_path);
  let renderedStat: Awaited<ReturnType<typeof stat>>;
  try {
    renderedStat = await stat(renderedPath);
  } catch (e: any) {
    fail(`Step 8 — rendered file not found: ${renderedPath}`, e?.message);
  }
  if (renderedStat!.size !== 512) {
    fail(`Step 8 — rendered file size mismatch: expected 512, got ${renderedStat!.size}`);
  }
  pass(`Step 8 — Rendered companion on disk (${renderedPath}, ${renderedStat!.size} bytes)`);

  // ── Step 9: Reconciliation feed ──────────────────────────────────────────
  const r5 = await fetch(
    `${API}/api/libraries/${libraryId}/backup/state?device_id=${encodeURIComponent(DEVICE_ID)}`,
  );
  await assertStatus(r5, 200, "reconciliation feed");
  const stateBody = await r5.json() as { assets: { phasset_local_id: string; maple_id: string; rel_path: string }[] };
  const found = stateBody.assets.find((a) => a.phasset_local_id === PHID);
  if (!found) {
    fail(
      `Step 9 — PHID not in reconciliation feed (${PHID})`,
      `got: ${JSON.stringify(stateBody.assets)}`,
    );
  }
  if (found.maple_id !== MAPLE_ID) {
    fail(`Step 9 — reconciliation feed maple_id mismatch`, JSON.stringify(found));
  }
  pass(`Step 9 — Reconciliation feed contains the asset (rel_path=${found.rel_path})`);

  // ── Step 10: Notify deleted ───────────────────────────────────────────────
  const r6 = await fetch(`${API}/api/libraries/${libraryId}/backup/notify-deleted`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Maple-Device-Id": DEVICE_ID,
    },
    body: JSON.stringify({ phasset_local_ids: [PHID] }),
  });
  await assertStatus(r6, 200, "notify-deleted");
  const delBody = await r6.json() as { updated: number };
  if (delBody.updated !== 1) {
    fail(`Step 10 — notify-deleted: expected updated=1, got ${delBody.updated}`);
  }
  pass("Step 10 — Delete notification accepted (updated=1)");

  // ── Step 11: Verify deleted_from_photos in MongoDB ───────────────────────
  const row = await assetsColl.findOne({ maple_id: MAPLE_ID });
  if (!row) {
    fail(`Step 11 — asset row not found in MongoDB (maple_id=${MAPLE_ID})`);
  }
  if (row!.deleted_from_photos !== true) {
    fail(
      `Step 11 — deleted_from_photos is not true`,
      `row: ${JSON.stringify({ maple_id: row!.maple_id, deleted_from_photos: row!.deleted_from_photos })}`,
    );
  }
  pass("Step 11 — deleted_from_photos=true confirmed in MongoDB");

  // ── Step 12: Cleanup ──────────────────────────────────────────────────────
  await assetsColl.deleteMany({ maple_id: MAPLE_ID });
  await uploadSessionsColl.deleteMany({ device_id: DEVICE_ID });
  await backupSessionsColl.deleteMany({ device_id: DEVICE_ID });
  await geocodeColl.deleteOne({ _id: GEO_CACHE_KEY });
  await foldersColl.deleteOne({ _id: libraryObjectId });
  await rm(libDir, { recursive: true, force: true });
  await mongo.close();
  pass("Step 12 — Cleanup complete (Mongo docs removed, temp dir deleted)");

  console.log("\n  All 12 steps passed — PhotoKit backup endpoints verified.\n");
}

main().catch((err) => {
  console.error("\n  FAIL  Smoke test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
