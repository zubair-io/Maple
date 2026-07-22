import { afterEach, describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
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
    const result = await transcribeStage.handler(asset('voice.m4a') as never, {} as never);
    expect((result as { patch: Record<string, unknown> }).patch['stages.meili.version']).toBe(0);
    expect((result as { patch: { transcript: { text: string } } }).patch.transcript.text).toBe(
      'hello there',
    );
  });
});
