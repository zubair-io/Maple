/**
 * `pendingEnrichment` / `normaliseEnrichment` — the read-side normaliser that
 * every asset DTO runs its enrichment bookkeeping through.
 *
 * These two functions are pure and need no database, but until the SQLite
 * cutover (#3787) their only unit test lived inside a MongoDB integration suite
 * (`tests/indexer-images-repo.test.ts`) that had to connect to a server to run
 * at all — and that went away with the collection it exercised. They matter more
 * now, not less: on Mongo the fast-tier upsert seeded a full `enrichment`
 * subdocument on insert, so a partial one was a legacy shape; here the stage
 * bookkeeping is rows in `enrichment_state`, an asset with none is the ordinary
 * case, and `normaliseEnrichment` is what makes an absent row read as pending
 * rather than as a hole in the DTO.
 *
 * Callers: `db/assets.transform.ts`, `db/sqlite/repos/assets.dto.ts` and
 * `db/sqlite/repos/stage-documents.repo.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { normaliseEnrichment, pendingEnrichment } from './schema.ts';

const PENDING_STAGE = {
  done_at: null,
  locked_by: null,
  lease_expires_at: null,
  attempts: 0,
  last_error: null,
  version: null,
  dead_letter_at: null,
};

describe('pendingEnrichment', () => {
  test('is exactly three stages, each with the full pending shape', () => {
    // Deliberately a strict equality rather than a subset check: a fourth stage
    // appearing here would reach every DTO, and a missing key would read as
    // `undefined` at clients that expect `null`.
    expect(pendingEnrichment()).toEqual({
      geocode: PENDING_STAGE,
      face: PENDING_STAGE,
      describe: PENDING_STAGE,
    });
  });

  test('hands out a fresh object each call', () => {
    const first = pendingEnrichment();
    first.geocode.attempts = 9;
    expect(pendingEnrichment().geocode.attempts).toBe(0);
  });
});

describe('normaliseEnrichment', () => {
  test('nothing at all reads as fully pending', () => {
    for (const absent of [undefined, null, {}]) {
      expect(normaliseEnrichment(absent)).toEqual(pendingEnrichment());
    }
  });

  test('a partial stage keeps what it has and defaults the rest', () => {
    // `Partial<Enrichment>` makes each stage optional but not each stage's own
    // fields, so the shape this function exists to repair cannot be written in
    // its parameter type. A stored row genuinely can be this shape — every
    // field of `stage_state` except the key is nullable or defaulted — which is
    // why the cast belongs here rather than a wider parameter type belonging in
    // the schema.
    const normalised = normaliseEnrichment({
      geocode: { done_at: '2026-05-08T00:00:00.000Z', version: 2 },
    } as never);

    expect(normalised.geocode.done_at).toBe('2026-05-08T00:00:00.000Z');
    expect(normalised.geocode.version).toBe(2);
    // The fields the caller did not supply come from the pending shape, so a
    // stage that has run once is never missing its retry bookkeeping.
    expect(normalised.geocode.attempts).toBe(0);
    expect(normalised.geocode.locked_by).toBeNull();
    // The other two stages are untouched by one stage's progress.
    expect(normalised.face).toEqual(PENDING_STAGE);
    expect(normalised.describe).toEqual(PENDING_STAGE);
  });
});
