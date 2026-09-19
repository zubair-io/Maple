#!/usr/bin/env bun
/**
 * End-to-end smoke test for the PhotoKit backup server endpoints.
 *
 * Runs against a local Maple API server on $MAPLE_API_URL (default
 * http://localhost:3000), and reads and writes the same SQLite library file
 * that server is using.
 *
 * Prerequisites:
 *   1. API server running:  cd src/api && bun run dev
 *
 * There is no database service to start — the library is a single SQLite file,
 * which the server creates on its first boot.
 *
 * Usage:
 *   bun src/scripts/test_backup_smoke.ts
 *   # or, after chmod +x:
 *   src/scripts/test_backup_smoke.ts
 *
 * Environment variables:
 *   MAPLE_API_URL     — API base URL (default: http://localhost:3000)
 *   MAPLE_SQLITE_PATH — library database file (default: src/api/data/maple.sqlite)
 *
 * Exit code:
 *   0 — all steps passed
 *   non-zero — a step failed (the failing step is printed to stderr)
 *
 * What it tests:
 *   Step 1 — Create a library folder (direct SQLite insert; /api/folders is auth-gated)
 *   Step 2 — Seed a geocode_cache entry for Tokyo so the path-formatter gets a location name
 *   Step 3 — Upload a 1024-byte "RAW" in two chunks via POST /api/libraries/:id/backup/ingest
 *   Step 4 — Verify the assembled file landed on disk at the expected location
 *   Step 5 — Upload an XMP sidecar via POST /api/libraries/:id/backup/sidecar
 *   Step 6 — Verify the sidecar file on disk
 *   Step 7 — Upload a rendered companion (single chunk) via POST /api/libraries/:id/backup/rendered
 *   Step 8 — Verify the rendered companion on disk
 *   Step 9 — Fetch the reconciliation feed via GET /api/libraries/:id/backup/state
 *   Step 10 — Mark the asset deleted via POST /api/libraries/:id/backup/notify-deleted
 *   Step 11 — Assert deleted_from_photos=1 on the asset row
 *   Step 12 — Cleanup: remove test data from disk and from every table it wrote
 */

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newObjectIdHex } from '../api/src/db/object-id.ts';
import { sqliteDatabasePath } from '../api/src/db/sqlite/database-path.ts';

const API = process.env.MAPLE_API_URL ?? 'http://localhost:3000';

// The server resolves a relative MAPLE_SQLITE_PATH against its own working
// directory, which is src/api — that is where `bun run dev` starts it. This
// script runs from the repo root, where the same relative string would name
// <repo>/data/maple.sqlite and miss the file entirely. Resolving it against
// src/api explicitly is what makes both processes open the same database; an
// absolute MAPLE_SQLITE_PATH passes through untouched.
const API_DIR = resolve(import.meta.dir, '..', 'api');
const DB_PATH = resolve(API_DIR, sqliteDatabasePath());

// Use the PID to avoid collisions when the test is run concurrently.
const DEVICE_ID = `smoke-test-device-${process.pid}`;
const PHID = `smoke/${process.pid}/IMG_0001`;
// A deterministic BLAKE3-shaped hex string (the server treats it as opaque).
const MAPLE_ID = `smoke${process.pid.toString(16).padStart(10, '0')}deadbeef12345678`;
// `slug` is NOT NULL UNIQUE and addresses the library in public URLs, so it
// carries the PID too.
const LIBRARY_SLUG = `smoke-test-${process.pid}`;

// Tokyo, 2024-03-15.
const LAT = '35.68';
const LON = '139.69';
// Quantised cache key (4 decimal places — matches quantizedKey() in coordinate-cache.ts).
const GEO_CACHE_KEY = `lat:35.68,lon:139.69`;
// The ingest path reads the cache through CoordinateCache, which treats an
// entry stamped with a different version as a miss. This is
// GEOCODE_HANDLER_VERSION in workers/stages/geocode.ts.
const GEOCODER_VERSION = 1;
const CAPTURE_DATE = '2024-03-15T10:30:00Z';
const FILENAME = 'IMG_0001.HEIC';

// Expected relative path under the library, derived from path-formatter.ts logic:
//   With location (USA → State, else Country): <year>/<State|Country>/<Town/City||Place>/<filename>
//   → 2024/Japan/Tokyo/IMG_0001.HEIC
const EXPECTED_REL_PATH = `2024/Japan/Tokyo/${FILENAME}`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pass(msg: string): void {
  console.log(`  PASS  ${msg}`);
}

function fail(msg: string, detail?: string): never {
  console.error(`  FAIL  ${msg}${detail ? `\n        ${detail}` : ''}`);
  process.exit(1);
}

async function assertStatus(resp: Response, expected: number, label: string): Promise<void> {
  if (resp.status !== expected) {
    const body = await resp.text().catch(() => '(unreadable body)');
    fail(`${label}: expected HTTP ${expected}, got ${resp.status}`, body);
  }
}

/** One row of `geocode_cache`, as the table stores it. */
interface GeocodeRow {
  place: string;
  fetched_at: string;
  geocoder_version: number;
}

const GEOCODE_SELECT_SQL = `SELECT place, fetched_at, geocoder_version FROM geocode_cache WHERE id = ?`;

// The same upsert geocode-cache.repo.ts issues. Used twice here: once to seed
// Tokyo, and once in step 12 to put back an entry that was already there.
const GEOCODE_UPSERT_SQL = `
  INSERT INTO geocode_cache (id, place, fetched_at, geocoder_version) VALUES (?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET
    place = excluded.place,
    fetched_at = excluded.fetched_at,
    geocoder_version = excluded.geocoder_version`;

/**
 * Open the library database the running server is using.
 *
 * Never creates the file: an empty database would have no schema, so every
 * statement below would fail with a confusing "no such table" instead of the
 * real problem, which is that this script and the server disagree about where
 * the library lives.
 */
function openLibraryDb(): Database {
  if (!existsSync(DB_PATH)) {
    fail(
      `library database not found at ${DB_PATH}`,
      'Set MAPLE_SQLITE_PATH to the file the server uses, or start the server once ' +
        '(cd src/api && bun run dev) — it creates the file on its first boot.',
    );
  }
  try {
    const db = new Database(DB_PATH, { readwrite: true, create: false });
    // Foreign keys are off by default on every new connection, and the cleanup
    // in step 12 needs them twice over: deleting the asset row has to take its
    // locations, links and search row with it, and the folder row must not go
    // while a location still points at it. The busy timeout covers the server
    // writing to the same file while this script does.
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  } catch (e: any) {
    fail(`library database at ${DB_PATH} could not be opened`, e?.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n  Maple PhotoKit backup — end-to-end smoke test');
  console.log(`  API:   ${API}`);
  console.log(`  DB:    ${DB_PATH}`);
  console.log(`  PID:   ${process.pid}`);
  console.log(`  PHID:  ${PHID}`);
  console.log('');

  // ── Library database ─────────────────────────────────────────────────────
  const db = openLibraryDb();

  // ── Healthcheck ──────────────────────────────────────────────────────────
  try {
    const hc = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!hc.ok) throw new Error(`status ${hc.status}`);
  } catch (e: any) {
    fail(`API server unreachable at ${API} — start it with: cd src/api && bun run dev`, e?.message);
  }

  // ── Create temp library folder on disk ──────────────────────────────────
  const libDir = await mkdtemp(join(tmpdir(), 'maple-smoke-'));
  console.log(`  Library dir: ${libDir}`);

  // ── Step 1: Register library in SQLite directly ──────────────────────────
  // /api/folders is behind requireAuth. We insert the folder row directly so
  // the backup routes, which resolve :libraryId straight out of this table,
  // can find it. The id is the same 24-character hex every client holds.
  const libraryId = newObjectIdHex();
  db.run(
    `INSERT INTO folders (id, path, slug, label, last_scan, file_count, created_at)
     VALUES (?, ?, ?, ?, NULL, 0, ?)`,
    [libraryId, libDir, LIBRARY_SLUG, 'smoke-test', new Date().toISOString()],
  );
  pass(`Step 1 — Library seeded in SQLite (${libraryId})`);

  // ── Step 2: Seed geocode_cache for Tokyo ─────────────────────────────────
  // The key is a real quantised coordinate rather than a PID-scoped one, so a
  // developer's database may already hold a genuine Tokyo entry. Read it first
  // and put it back in step 12, instead of throwing away a cached geocode this
  // script did not fetch.
  const priorGeocode = db.query(GEOCODE_SELECT_SQL).get(GEO_CACHE_KEY) as GeocodeRow | null;
  // The Place payload the path-formatter reads: the country comes from
  // `address`, the town from `rollups.locality`, and the first POI is the
  // fallback. The column is TEXT with a json_valid() check, so it is stored as
  // a JSON string.
  const tokyoPlace = {
    source: 'nominatim',
    geocoder_version: GEOCODER_VERSION,
    geocoded_at: new Date().toISOString(),
    lat: 35.68,
    lon: 139.69,
    display_name: 'Tokyo, Japan',
    address: { city: 'Tokyo', country: 'Japan', country_code: 'jp' },
    pois: [{ name: 'Tokyo', category: 'place', type: 'city' }],
    rollups: { locality: 'Tokyo', region: 'Tokyo', country_code: 'jp' },
    search_blob: 'Tokyo Japan',
  };
  db.run(GEOCODE_UPSERT_SQL, [
    GEO_CACHE_KEY,
    JSON.stringify(tokyoPlace),
    new Date().toISOString(),
    GEOCODER_VERSION,
  ]);
  pass('Step 2 — Geocode cache seeded for Tokyo (lat:35.68,lon:139.69)');

  // ── Step 3: Upload in two chunks ─────────────────────────────────────────
  const originalBytes = Buffer.alloc(1024, 0xab);

  // Chunk 1 — bytes 0–511 (intermediate; no X-Maple-Maple-Id)
  const r1 = await fetch(`${API}/api/libraries/${libraryId}/backup/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Maple-Device-Id': DEVICE_ID,
      'X-Maple-Phasset-Id': PHID,
      'X-Maple-Capture-Date': CAPTURE_DATE,
      'X-Maple-Lat': LAT,
      'X-Maple-Lon': LON,
      'X-Maple-Filename': FILENAME,
      'X-Maple-Total-Bytes': '1024',
      'Content-Range': 'bytes 0-511/1024',
    },
    body: originalBytes.subarray(0, 512),
  });
  await assertStatus(r1, 202, 'ingest chunk 1');
  const body1 = (await r1.json()) as { next_offset: number };
  if (body1.next_offset !== 512) {
    fail('ingest chunk 1: expected next_offset=512', JSON.stringify(body1));
  }
  pass('Step 3a — Chunk 1 accepted (202, next_offset=512)');

  // Chunk 2 — bytes 512–1023 (final chunk; must include X-Maple-Maple-Id)
  const r2 = await fetch(`${API}/api/libraries/${libraryId}/backup/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Maple-Device-Id': DEVICE_ID,
      'X-Maple-Phasset-Id': PHID,
      'X-Maple-Capture-Date': CAPTURE_DATE,
      'X-Maple-Lat': LAT,
      'X-Maple-Lon': LON,
      'X-Maple-Filename': FILENAME,
      'X-Maple-Total-Bytes': '1024',
      'X-Maple-Maple-Id': MAPLE_ID,
      'Content-Range': 'bytes 512-1023/1024',
    },
    body: originalBytes.subarray(512),
  });
  await assertStatus(r2, 200, 'ingest chunk 2 (final)');
  const body2 = (await r2.json()) as { maple_id: string; target_rel_path: string };
  if (body2.maple_id !== MAPLE_ID) {
    fail('ingest final chunk: maple_id mismatch', JSON.stringify(body2));
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
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml',
      'X-Maple-Device-Id': DEVICE_ID,
      'X-Maple-Phasset-Id': PHID,
      'X-Maple-Target-Rel-Path': body2.target_rel_path,
    },
    body: xmpPayload,
  });
  await assertStatus(r3, 200, 'sidecar upload');
  const sidecarBody = (await r3.json()) as { target_rel_path: string };
  pass(`Step 5 — Sidecar accepted (200), target_rel_path=${sidecarBody.target_rel_path}`);

  // ── Step 6: Verify sidecar on disk ───────────────────────────────────────
  const sidecarPath = filePath + '.xmp';
  let sidecarContent: string;
  try {
    sidecarContent = await readFile(sidecarPath, 'utf8');
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
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Maple-Device-Id': DEVICE_ID,
      'X-Maple-Phasset-Id': PHID,
      'X-Maple-Target-Rel-Path': body2.target_rel_path,
      'X-Maple-Filename-Ext': 'jpg',
      'X-Maple-Total-Bytes': '512',
      'X-Maple-Maple-Id': MAPLE_ID,
      'Content-Range': 'bytes 0-511/512',
    },
    body: renderedBytes,
  });
  await assertStatus(r4, 200, 'rendered companion upload');
  const renderedBody = (await r4.json()) as { target_rel_path: string };
  pass(
    `Step 7 — Rendered companion accepted (200), target_rel_path=${renderedBody.target_rel_path}`,
  );

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
  await assertStatus(r5, 200, 'reconciliation feed');
  const stateBody = (await r5.json()) as {
    assets: { phasset_local_id: string; maple_id: string; rel_path: string }[];
  };
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
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Maple-Device-Id': DEVICE_ID,
    },
    body: JSON.stringify({ phasset_local_ids: [PHID] }),
  });
  await assertStatus(r6, 200, 'notify-deleted');
  const delBody = (await r6.json()) as { updated: number };
  if (delBody.updated !== 1) {
    fail(`Step 10 — notify-deleted: expected updated=1, got ${delBody.updated}`);
  }
  pass('Step 10 — Delete notification accepted (updated=1)');

  // ── Step 11: Verify deleted_from_photos on the asset row ─────────────────
  // markDeletedFromPhotos (db/repos/backup.repo.ts) sets this column on
  // `assets`. Booleans are 0/1 integers here, so the flag reads as 1.
  const row = db
    .query(`SELECT id, maple_id, deleted_from_photos FROM assets WHERE maple_id = ?`)
    .get(MAPLE_ID) as { id: string; maple_id: string; deleted_from_photos: number } | null;
  if (!row) {
    fail(`Step 11 — asset row not found in SQLite (maple_id=${MAPLE_ID})`);
  }
  if (row.deleted_from_photos !== 1) {
    fail(
      `Step 11 — deleted_from_photos is not 1`,
      `row: ${JSON.stringify({ maple_id: row.maple_id, deleted_from_photos: row.deleted_from_photos })}`,
    );
  }
  pass('Step 11 — deleted_from_photos=1 confirmed in SQLite');

  // ── Step 12: Cleanup ──────────────────────────────────────────────────────
  // The order follows the foreign keys. The asset goes first, because deleting
  // it cascades its locations away and a surviving location would block the
  // folder delete. Every statement is scoped to an id this run minted, so a
  // concurrently running copy of this script keeps its own rows.
  db.run(`DELETE FROM assets WHERE maple_id = ?`, [MAPLE_ID]);
  db.run(`DELETE FROM upload_sessions WHERE library_id = ?`, [libraryId]);
  db.run(`DELETE FROM backup_sessions WHERE library_id = ?`, [libraryId]);
  if (priorGeocode === null) {
    db.run(`DELETE FROM geocode_cache WHERE id = ?`, [GEO_CACHE_KEY]);
  } else {
    db.run(GEOCODE_UPSERT_SQL, [
      GEO_CACHE_KEY,
      priorGeocode.place,
      priorGeocode.fetched_at,
      priorGeocode.geocoder_version,
    ]);
  }
  db.run(`DELETE FROM folders WHERE id = ?`, [libraryId]);
  db.close();
  await rm(libDir, { recursive: true, force: true });
  pass('Step 12 — Cleanup complete (rows removed, temp dir deleted)');

  console.log('\n  All 12 steps passed — PhotoKit backup endpoints verified.\n');
}

main().catch((err) => {
  console.error('\n  FAIL  Smoke test failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
