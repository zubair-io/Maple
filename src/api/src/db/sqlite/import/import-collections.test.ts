/**
 * Field-level comparison for the describe-stage payloads and every collection
 * that is not an asset (#3744).
 *
 * Companion to `import-fields.test.ts`, which covers the asset row and its
 * nested arrays. Split because the two together outgrew the file-size budget,
 * not because they test different things.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { importedFixture, type ImportedFixture } from './fixture.test-helpers.ts';
import { PLACE, iso, visionDoc } from './seed-fixtures.test-helpers.ts';

const fixture: ImportedFixture = importedFixture(`maple_import_collections_${process.pid}`);
const { one } = fixture;

beforeAll(fixture.setUp, 60_000);
afterAll(fixture.tearDown);

describe('the detail payloads', () => {
  it('stores vision whole and exposes the two facet paths', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{
      vision: string;
      vision_scene_type: string;
      vision_activity: string;
      ocr_text: string;
      description: string;
      transcript: string;
      metadata_override: string;
      derivative_audit: string;
      geo_inferred: string;
    }>(
      `SELECT vision, vision_scene_type, vision_activity, ocr_text, description, transcript,
              metadata_override, derivative_audit, geo_inferred
         FROM asset_detail WHERE asset_id = ?`,
      ids.assets.rich.toHexString(),
    );
    expect(JSON.parse(row.vision)).toEqual(visionDoc());
    expect(row.vision_scene_type).toBe('outdoor');
    expect(row.vision_activity).toBe('running');
    expect(row.ocr_text).toBe('ÉLAN — 12 °C\nline two');
    expect(row.description).toBe('A child in a red coat runs across a frozen field.');
    expect(JSON.parse(row.transcript)).toEqual({
      text: 'hello world',
      segments: [{ start: 0, end: 1.5, text: 'hello world' }],
      language: 'en',
      model: 'whisper',
      duration_sec: 1.5,
      generated_at: iso(3),
    });
    expect(JSON.parse(row.metadata_override)).toEqual({
      edited_at: iso(4),
      touched_fields: ['title', 'keywords'],
      title: 'Frozen field',
      keywords: ['winter', 'child'],
    });
    expect(JSON.parse(row.derivative_audit)).toEqual({
      thumb: { attempts: 1, last_reset_at: iso(4) },
    });
  });

  it('carries description_meta, which the AssetDoc interface does not declare', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    // The describe stage writes this field and `assets.transform.ts` reads it
    // through a `Record<string, unknown>` so it still reaches clients — it was
    // simply added after the interface froze. A mapper written from the
    // interface alone drops it on every asset in the library, silently.
    const row = one<{ description_meta: string }>(
      `SELECT description_meta FROM asset_detail WHERE asset_id = ?`,
      ids.assets.rich.toHexString(),
    );
    expect(JSON.parse(row.description_meta)).toEqual({
      provider: 'ollama',
      model: 'qwen2.5-vl',
      prompt_version: 7,
      generated_at: iso(3),
      cost_usd: 0,
    });
  });

  it('converts an ObjectId nested inside a JSON payload to its hex', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{ geo_inferred: string }>(
      `SELECT geo_inferred FROM asset_detail WHERE asset_id = ?`,
      ids.assets.rich.toHexString(),
    );
    expect(JSON.parse(row.geo_inferred)).toEqual({
      source: 'temporal-neighbor',
      donor_id: ids.assets.multiLocation.toHexString(),
      donor_delta_ms: 42_000,
      at: iso(4),
    });
  });

  it('moves the search blob to its own table', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{ search_blob: string }>(
      `SELECT search_blob FROM asset_search WHERE asset_id = ?`,
      ids.assets.rich.toHexString(),
    );
    expect(row.search_blob).toBe('Albany New York child red coat frozen field');
  });
});

describe('the rest of the library', () => {
  it('flattens the person cover bbox and converts the merge references', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{
      name: string;
      cover_asset_id: string;
      cover_bbox_x: number;
      cover_bbox_h: number;
      centroid: string;
      suggested_merge_person_id: string;
      suggested_merges: string;
      name_key: string;
    }>(
      `SELECT name, cover_asset_id, cover_bbox_x, cover_bbox_h, centroid,
              suggested_merge_person_id, suggested_merges, name_key
         FROM people WHERE id = ?`,
      ids.person.toHexString(),
    );
    expect(row.name).toBe('Alice Example');
    expect(row.cover_asset_id).toBe(ids.assets.rich.toHexString());
    expect(row.cover_bbox_x).toBeCloseTo(0.1, 6);
    expect(row.cover_bbox_h).toBeCloseTo(0.4, 6);
    expect(JSON.parse(row.centroid)).toEqual([0.1, 0.2, 0.3]);
    expect(row.suggested_merge_person_id).toBe(ids.mergedPerson.toHexString());
    expect(JSON.parse(row.suggested_merges)).toEqual([
      { person_id: ids.mergedPerson.toHexString(), score: 0.91 },
    ]);
    // The face count is derived from the faces table rather than stored, so
    // there is nothing to carry; the folded name key is stored and is.
    expect(row.name_key).toBe('alice example');
  });

  it('keeps a folder mirror list as JSON', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const row = one<{ mirrors: string; slug: string; file_count: number }>(
      `SELECT mirrors, slug, file_count FROM folders WHERE id = ?`,
      ids.libraryA.toHexString(),
    );
    expect(JSON.parse(row.mirrors)).toEqual([{ path: '/mirrors/a', enabled: true }]);
    expect(row.slug).toBe('library-a');
    expect(row.file_count).toBe(5);
  });

  it('renames worker_config.maxAttempts to max_attempts', () => {
    const { client } = fixture.state;
    if (client === null) return;
    const row = one<{
      concurrency: number;
      max_attempts: number;
      paused: number;
      pause_reason: string;
      last_seen_target_version: number;
    }>(
      `SELECT concurrency, max_attempts, paused, pause_reason, last_seen_target_version
         FROM worker_config WHERE name = 'describe'`,
    );
    expect(row.concurrency).toBe(2);
    expect(row.max_attempts).toBe(1);
    expect(row.paused).toBe(1);
    expect(row.pause_reason).toBe('no model');
    expect(row.last_seen_target_version).toBe(8);
  });

  it('keeps the discover sweeper interval, the other camelCase field', () => {
    const { client } = fixture.state;
    if (client === null) return;
    const row = one<{ sweep_dir_interval_ms: number }>(
      `SELECT sweep_dir_interval_ms FROM worker_config WHERE name = 'discover'`,
    );
    expect(row.sweep_dir_interval_ms).toBe(900);
  });

  it('flattens the job and import progress subdocuments into columns', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const job = one<{ progress_current: number; progress_total: number; params: string }>(
      `SELECT progress_current, progress_total, params FROM jobs LIMIT 1`,
    );
    expect(job.progress_current).toBe(1);
    expect(job.progress_total).toBe(1);
    expect(JSON.parse(job.params)).toEqual({ asset_ids: [ids.assets.rich.toHexString()] });

    const imported = one<{ count_copied: number; count_skipped: number; count_failed: number }>(
      `SELECT count_copied, count_skipped, count_failed FROM imports WHERE id = ?`,
      ids.importJob.toHexString(),
    );
    expect(imported).toEqual({ count_copied: 2, count_skipped: 0, count_failed: 0 });
  });

  it('round-trips a passkey public key as bytes, not as text', () => {
    const { client } = fixture.state;
    if (client === null) return;
    const row = one<{ public_key: Uint8Array; transports: string; counter: number }>(
      `SELECT public_key, transports, counter FROM credentials LIMIT 1`,
    );
    expect(Array.from(row.public_key)).toEqual([1, 2, 3, 4, 250]);
    expect(JSON.parse(row.transports)).toEqual(['internal', 'hybrid']);
    expect(row.counter).toBe(7);
  });

  it('turns the TTL dates into the ISO strings the expiry sweep reads', () => {
    const { client } = fixture.state;
    if (client === null) return;
    const invite = one<{ expires_at: string; code: string }>(
      `SELECT expires_at, code FROM invites LIMIT 1`,
    );
    expect(invite.expires_at).toBe('2026-02-01T00:00:00.000Z');
    expect(invite.code).toBe('ABCD2345');

    const refresh = one<{ expires_at: string; platform: string; secure: number }>(
      `SELECT expires_at, platform, secure FROM refresh_tokens LIMIT 1`,
    );
    expect(refresh.expires_at).toBe('2026-03-01T00:00:00.000Z');
    expect(refresh.platform).toBe('tvos');
    expect(refresh.secure).toBe(0);
  });

  it('derives an expiry for an upload session that relied on the TTL monitor', () => {
    const { client } = fixture.state;
    if (client === null) return;
    const row = one<{ created_at: string; expires_at: string; state: string }>(
      `SELECT created_at, expires_at, state FROM upload_sessions LIMIT 1`,
    );
    expect(row.created_at).toBe('2026-01-05T00:00:00.000Z');
    expect(row.expires_at).toBe('2026-01-12T00:00:00.000Z');
    expect(row.state).toBe('open');
  });

  it('keeps the geocode cache under its quantised string key', () => {
    const { client } = fixture.state;
    if (client === null) return;
    const row = one<{ id: string; place: string; fetched_at: string }>(
      `SELECT id, place, fetched_at FROM geocode_cache LIMIT 1`,
    );
    expect(row.id).toBe('lat:42.6526,lon:-73.7562');
    expect(JSON.parse(row.place)).toEqual(PLACE);
    expect(row.fetched_at).toBe('2026-01-02T00:00:00.000Z');
  });

  it('keeps a preset extra bag for keys this version does not understand', () => {
    const { client } = fixture.state;
    if (client === null) return;
    const row = one<{ fields: string; extra: string }>(`SELECT fields, extra FROM presets LIMIT 1`);
    expect(JSON.parse(row.fields)).toEqual({ exposure: 0.25, contrast: 12 });
    expect(JSON.parse(row.extra)).toEqual({ unknown_future_key: true });
  });

  /**
   * The per-file rows of an import older than the `import_files` collection
   * still live inside the `imports` document. They are read at runtime, so
   * dropping them would have rendered every pre-migration import with an empty
   * file list after the cutover.
   */
  it('turns an import that still holds its files inline into import_files rows', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const rows = fixture.all<{ idx: number; src: string; kind: string; state: string }>(
      `SELECT idx, src, kind, state FROM import_files WHERE import_id = ? ORDER BY idx`,
      ids.legacyImportJob.toHexString(),
    );
    expect(rows).toEqual([
      { idx: 0, src: '/incoming/old/b.dng', kind: 'image', state: 'copied' },
      { idx: 1, src: '/incoming/old/b.mov', kind: 'movie', state: 'skipped_duplicate' },
    ]);
  });

  /** The third shape: an import whose files are only ever rows. */
  it('takes the rows of an import that never held its files inline', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const rows = fixture.all<{ idx: number; src: string }>(
      `SELECT idx, src FROM import_files WHERE import_id = ? ORDER BY idx`,
      ids.importJob.toHexString(),
    );
    expect(rows).toEqual([
      { idx: 0, src: '/incoming/a.dng' },
      { idx: 1, src: '/incoming/a.xmp' },
    ]);
  });

  /**
   * An import written during the changeover carries both copies, and the rows
   * are the canonical one (#3791). Before this rule the inline half was
   * written first, the collection's rows lost the unique constraint on
   * `(import_id, idx)`, and the whole import document was rejected — which is
   * what failed the production verification 31 rows short.
   *
   * The seeded copies disagree on `src` on purpose. Production's agree, so a
   * test built on matching copies would pass whichever one landed.
   */
  it('prefers the promoted rows to the inline copy when an import has both', () => {
    const { client, ids } = fixture.state;
    if (client === null || ids === null) return;
    const rows = fixture.all<{ idx: number; src: string; dest: string }>(
      `SELECT idx, src, dest FROM import_files WHERE import_id = ? ORDER BY idx`,
      ids.mixedImportJob.toHexString(),
    );
    expect(rows).toEqual([
      { idx: 0, src: '/incoming/mixed/promoted-row.dng', dest: '2025/11/promoted-row.dng' },
    ]);
  });
});
