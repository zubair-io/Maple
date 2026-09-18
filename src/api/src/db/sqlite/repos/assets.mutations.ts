/**
 * Assets repository — the non-trash writes.
 *
 * Five verbs, each the SQLite counterpart of the identically-named function in
 * `db/assets.repo.ts`, returning the same result shape so the routes that read
 * `matchedCount` off them keep compiling after the cutover (#3752).
 *
 * ## Where the document fanned out
 *
 * A Mongo `$set` on an asset writes one document, so a mutation that touches
 * several of its parts is inherently atomic. Here the same fields live in
 * three tables — `assets` for the place JSON, `asset_detail` for the caption,
 * `asset_search` for the synthesised search blob, `stage_state` for the
 * pipeline re-arm — so each mutation is a `BEGIN IMMEDIATE` transaction on the
 * single writer, and either all of it lands or none of it does.
 *
 * ## The one read-then-write window
 *
 * The Mongo overrides recompute `search_blob` inside the update, using an
 * aggregation expression that reads the row's other text sources server-side.
 * SQLite has no way to express the tokeniser as an expression without
 * reimplementing it in SQL, which would be a second implementation to keep in
 * step with `composeSearchBlob` — so these two functions read the other
 * sources, compose the blob in TypeScript with that shared function, and write
 * the result. A concurrent write to `description` or `ocr_text` between the
 * read and the transaction would be overwritten.
 *
 * That window is acceptable here and it is worth being explicit about why.
 * `asset.search_blob` has exactly two other writers: the boot-time backfill in
 * `db/client.ts`, which runs once per database, and the other of these two
 * override routes, which an operator drives by hand. And both of these
 * mutations re-arm the `meili` stage in the same transaction, so the search
 * document is rebuilt from the live row afterwards regardless — the same
 * "inline write is the fast path, the stage re-arm is the correctness
 * mechanism" argument the trash workflows already rest on.
 */

import type { ObjectId } from 'mongodb';
import type { SqlStatement } from '../protocol.ts';
import { composeSearchBlob } from '../../../enrichment/search-blob.ts';
import type { Enrichment, Place } from '../../schema.ts';
import { SEARCH_BLOB_INPUTS_SQL } from './assets.sql.ts';
import { meiliRearmStatement } from './assets.stage-rearm.ts';
import { assetsDb, updateOutcome, type SqliteDb, type UpdateOutcome } from './db-handle.ts';

/** The sources the synthesised search blob is rebuilt from. */
interface SearchBlobInputs {
  place_search_blob: string | null;
  captured_month: number | null;
  description: string | null;
  ocr_text: string | null;
}

const SEARCH_BLOB_UPSERT_SQL = `
  INSERT INTO asset_search (asset_id, search_blob) VALUES (?, ?)
  ON CONFLICT (asset_id) DO UPDATE SET search_blob = excluded.search_blob`;

const SEARCH_BLOB_DELETE_SQL = `DELETE FROM asset_search WHERE asset_id = ?`;

const DESCRIPTION_UPSERT_SQL = `
  INSERT INTO asset_detail (asset_id, description) VALUES (?, ?)
  ON CONFLICT (asset_id) DO UPDATE SET description = excluded.description`;

const ENRICHMENT_UPSERT_SQL = `
  INSERT INTO enrichment_state
    (asset_id, stage, done_at, locked_by, lease_expires_at, attempts, last_error,
     version, dead_letter_at)
  SELECT id, ?, NULL, NULL, NULL, 0, NULL, ?, NULL FROM assets WHERE id = ?
  ON CONFLICT (asset_id, stage) DO UPDATE SET
    done_at = NULL, locked_by = NULL, lease_expires_at = NULL,
    attempts = 0, last_error = NULL, version = excluded.version, dead_letter_at = NULL`;

/**
 * Writes the blob, or removes the row when it is empty.
 *
 * `asset_search` holds a row only for an asset with a non-empty blob — the
 * partial filter the Mongo text index spelled out, expressed as a `CHECK`
 * here — so "the blob became empty" is a delete rather than an update to `''`.
 */
function searchBlobStatement(assetId: string, blob: string): SqlStatement {
  if (blob === '') return { sql: SEARCH_BLOB_DELETE_SQL, params: [assetId] };
  return { sql: SEARCH_BLOB_UPSERT_SQL, params: [assetId, blob] };
}

/**
 * Flip `has_xmp` on a single asset. Called by the XMP write and delete
 * handlers so the working-set filter can find the asset cheaply.
 */
export async function setHasXmp(
  id: ObjectId,
  value: boolean,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  const db = assetsDb(dbOverride);
  const result = await db.write(`UPDATE assets SET has_xmp = ? WHERE id = ?`, [
    value ? 1 : 0,
    id.toHexString(),
  ]);
  return updateOutcome(result.changes);
}

/**
 * Record an XMP edit: mark `has_xmp` and bump the monotonic `sidecar_ver` edit
 * counter, in one statement.
 *
 * `sidecar_ver` is a general edit-generation counter consumed by the client
 * editor's write policy; it keys no cache file. The developed preview is a
 * single unversioned `<filename>.avif` that the editor overwrites in place,
 * and the serving routes bust their ETag from that file's own mtime and size.
 */
export async function recordSidecarEdit(
  id: ObjectId,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  const db = assetsDb(dbOverride);
  const result = await db.write(
    `UPDATE assets SET has_xmp = 1, sidecar_ver = sidecar_ver + 1 WHERE id = ?`,
    [id.toHexString()],
  );
  return updateOutcome(result.changes);
}

/**
 * Both overrides are the same three steps — read the other blob sources, write
 * the override, then rewrite the blob and re-arm the search stage — with one
 * source substituted and one statement differing, so they share a body.
 *
 * `override` supplies the field this caller is changing; every other source
 * comes off the row that was just read. The returned outcome reports one
 * matched row when the asset exists and none when it does not, which is what
 * the Mongo `updateOne` on `{ _id }` reports.
 */
async function applyOverride(
  db: SqliteDb,
  hex: string,
  write: (inputs: SearchBlobInputs) => { statement: SqlStatement; blob: string },
): Promise<UpdateOutcome> {
  const rows = await db.read<SearchBlobInputs>(SEARCH_BLOB_INPUTS_SQL, [hex]);
  const inputs = rows[0];
  if (!inputs) return updateOutcome(0);
  const { statement, blob } = write(inputs);
  await db.transaction([statement, searchBlobStatement(hex, blob), meiliRearmStatement(hex)]);
  return updateOutcome(1);
}

/** The blob for one asset, given its stored sources and this caller's override. */
function blobFor(
  inputs: SearchBlobInputs,
  override: { placeSearchBlob?: string | null; description?: string | null },
): string {
  const placeBlob =
    override.placeSearchBlob === undefined ? inputs.place_search_blob : override.placeSearchBlob;
  return composeSearchBlob({
    place: placeBlob === null ? null : { search_blob: placeBlob },
    description: override.description === undefined ? inputs.description : override.description,
    ocrText: inputs.ocr_text,
    capturedMonth: inputs.captured_month,
  });
}

/**
 * Set the manual `place` override and recompute the search blob. `place ===
 * null` clears the override.
 *
 * `place.search_blob ?? null` rather than `place.search_blob`: the route's body
 * schema is open (`t.Object({}, { additionalProperties: true })`), so an
 * operator can hand-write a place with a display name and rollups but no
 * internal denormalised blob. `undefined` is {@link blobFor}'s "this caller is
 * not touching place" sentinel, so passing it through would rebuild the blob
 * from the *previous* place and leave the old locality searchable on an asset
 * that has just been re-placed. Collapsing to `null` is what the Mongo repo
 * does (`place?.search_blob ?? null`) and means "this place contributes no
 * tokens".
 */
export async function setPlaceOverride(
  id: ObjectId,
  place: Place | null,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  const hex = id.toHexString();
  return applyOverride(assetsDb(dbOverride), hex, (inputs) => ({
    statement: {
      sql: `UPDATE assets SET place = ? WHERE id = ?`,
      params: [place === null ? null : JSON.stringify(place), hex],
    },
    blob: blobFor(inputs, { placeSearchBlob: place === null ? null : (place.search_blob ?? null) }),
  }));
}

/**
 * Set the manual `description` override and recompute the search blob.
 * `text === null` clears the override.
 */
export async function setDescriptionOverride(
  id: ObjectId,
  text: string | null,
  dbOverride?: SqliteDb,
): Promise<UpdateOutcome> {
  const hex = id.toHexString();
  return applyOverride(assetsDb(dbOverride), hex, (inputs) => ({
    statement: { sql: DESCRIPTION_UPSERT_SQL, params: [hex, text] },
    blob: blobFor(inputs, { description: text }),
  }));
}

/**
 * Requeue one enrichment stage on a single asset: bump its version and clear
 * the worker-claim fields so the next tick picks the row up. Returns the new
 * version, or `null` when the asset does not exist.
 *
 * The read and the write are two statements, exactly as they are on Mongo —
 * two operators racing to requeue the same stage can therefore land on the
 * same version number, which is harmless because the effect either way is
 * "this stage runs again".
 */
export async function requeueEnrichmentStage(
  id: ObjectId,
  stage: keyof Enrichment,
  dbOverride?: SqliteDb,
): Promise<{ version: number } | null> {
  const db = assetsDb(dbOverride);
  const hex = id.toHexString();
  const rows = await db.read<{ id: string; version: number | null }>(
    `SELECT a.id, e.version AS version
       FROM assets a
       LEFT JOIN enrichment_state e ON e.asset_id = a.id AND e.stage = ?
      WHERE a.id = ?`,
    [stage, hex],
  );
  const current = rows[0];
  if (!current) return null;
  const nextVersion = (current.version ?? 0) + 1;
  const result = await db.write(ENRICHMENT_UPSERT_SQL, [stage, nextVersion, hex]);
  if (result.changes === 0) return null;
  return { version: nextVersion };
}
