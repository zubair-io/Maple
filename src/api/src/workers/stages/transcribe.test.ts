import { afterEach, describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { STAGE_STATE_MEDIA_NARROWING } from '../../db/sqlite/ddl/stage-state.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import transcribeStage, {
  setTranscribeDepsForTests,
  transcriptionTimeoutMs,
} from './transcribe.ts';

const libraryId = new ObjectId();
const asset = (filename: string) => ({
  _id: new ObjectId(),
  maple_id: 'a'.repeat(32),
  fileinfo: [{ path: '', filename, library_id: libraryId, deleted_at: null }],
  stages: {},
});

afterEach(() => {
  setTranscribeDepsForTests(null);
  setLibraryRootsForTests(null);
});

function inject(overrides: Record<string, unknown> = {}): void {
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), '/lib']]));
  setTranscribeDepsForTests({
    hasAudioStream: async () => true,
    extractAudioWav: async () => true,
    ensureWhisperModel: async () => '/model.bin',
    wavByteLength: async () => 44,
    assertReadable: async () => {},
    transcribeWav: async () => ({
      text: 'hello there',
      language: 'en',
      segments: [{ start: 0, end: 1, text: 'hello there' }],
    }),
    tier: 'medium.en',
    ...overrides,
  } as never);
}

describe('transcribe stage', () => {
  it('scales the timeout from PCM duration within hard bounds', () => {
    expect(transcriptionTimeoutMs(44)).toBe(5 * 60_000);
    expect(transcriptionTimeoutMs(44 + 16_000 * 2 * 60 * 60 * 24)).toBe(6 * 60 * 60_000);
  });

  it('claims only video/audio assets (no photo sweep) by the indexed media_kind (#3492)', () => {
    // The claim is narrowed so the stage never sweeps the photo library stamping
    // not-media skips. The predicate reads the denormalised `media_kind` column,
    // which has a partial index over exactly the two minority kinds — it
    // replaced a filename regex that no multikey index could ever filter, so
    // the claim fetched the whole library to evaluate it.
    //
    // Asserted as text because the claim builder interpolates this fragment
    // verbatim: a predicate that stopped naming `stage_state.asset_id` would
    // still type-check and would silently correlate against nothing.
    expect(transcribeStage.claimResidual?.params).toEqual(['video', 'audio']);
    expect(transcribeStage.claimResidual?.sql).toContain('id = stage_state.asset_id');
    expect(transcribeStage.claimResidual?.sql).toContain('media_kind IN (?, ?)');
  });

  it('leads the residual with the term that selects the partial index (#3795)', () => {
    // The `EXISTS` above decides WHICH assets are claimed; this term decides
    // how many rows the scan reads to find them, and it only does that if it
    // is spelled exactly as `stage_claim_media`'s own `WHERE`. Taking it from
    // the DDL rather than retyping it is what keeps the two in step, and
    // asserting the stage actually uses it is what keeps a future edit from
    // quietly paraphrasing it back into a full-library walk.
    expect(transcribeStage.claimResidual?.sql.startsWith(STAGE_STATE_MEDIA_NARROWING)).toBe(true);
  });

  it('skips non-media and silent video', async () => {
    inject();
    expect(await transcribeStage.handler(asset('photo.jpg') as never, {} as never)).toEqual({
      skip: 'not-media',
    });
    inject({ hasAudioStream: async () => false });
    expect(await transcribeStage.handler(asset('clip.mp4') as never, {} as never)).toEqual({
      skip: 'no-audio',
    });
  });

  it('stores transcript and rearms search', async () => {
    inject();
    const doc = asset('voice.m4a');
    const result = (await transcribeStage.handler(doc as never, {} as never)) as {
      patch: readonly { sql: string; params: unknown[] }[];
      invalidates: readonly string[];
    };

    // The re-arm is declared, not written: the runner commits it in the same
    // transaction as this stage's success row, where the Mongo handler wrote
    // five `stages.meili.*` keys itself and could crash between them.
    expect(result.invalidates).toEqual(['meili']);
    expect(result.patch).toHaveLength(1);
    expect(result.patch[0]!.sql).toContain('INSERT INTO asset_detail');
    expect(result.patch[0]!.params[1]).toBe(doc._id.toHexString());
    expect(JSON.parse(result.patch[0]!.params[0] as string)).toMatchObject({
      text: 'hello there',
      model: 'medium.en',
    });
  });

  it('writes the transcript through a statement the foreign key cannot reject', async () => {
    inject();
    const result = (await transcribeStage.handler(asset('voice.m4a') as never, {} as never)) as {
      patch: readonly { sql: string }[];
    };
    // `SELECT … FROM assets WHERE id = ?` rather than a bare VALUES: an asset
    // deleted between the claim and the writeback must be a no-op, the way the
    // Mongo `updateOne` on a missing `_id` was, and not a foreign-key failure
    // that rolls back the whole tick's batch.
    expect(result.patch[0]!.sql).toContain('FROM assets WHERE id = ?');
  });

  it('propagates a real ENOENT before probing media', async () => {
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
    inject({ assertReadable: async () => Promise.reject(error) });
    await expect(transcribeStage.handler(asset('voice.m4a') as never, {} as never)).rejects.toBe(
      error,
    );
  });
});
