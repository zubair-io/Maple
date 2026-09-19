import { afterEach, describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { RemoteError } from '../../enrichment/describe-providers/index.ts';
import { STAGE_STATE_VIDEO_NARROWING } from '../../db/sqlite/ddl/stage-state.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import type { SampledFrame } from '../../video/sample-frames.ts';
import type { StageResult } from '../run-stage.ts';
import videoDescribeStage, {
  setVideoDescribeDepsForTests,
  videoDescribeHandler,
} from './video-describe.ts';

/**
 * The description and its provenance, read back out of the upsert's bound JSON.
 *
 * The patch is one `asset_detail` statement now rather than a map of document
 * fields, so the assertions decode parameters instead of reading properties.
 */
function videoUpsertParams(result: StageResult): string[] {
  if (!('patch' in result)) throw new Error(`expected a patch, got ${JSON.stringify(result)}`);
  const statement = result.patch[0];
  if (statement === undefined || !statement.sql.includes('video_description')) {
    throw new Error('expected a video-description upsert in the patch');
  }
  return statement.params as string[];
}

function patchedVideoDescription(result: StageResult): unknown {
  return JSON.parse(videoUpsertParams(result)[0]!) as unknown;
}

function patchedVideoMeta(result: StageResult): Record<string, unknown> {
  return JSON.parse(videoUpsertParams(result)[1]!) as Record<string, unknown>;
}

const libraryId = new ObjectId();
const asset = (filename: string) => ({
  _id: new ObjectId(),
  maple_id: 'a'.repeat(32),
  fileinfo: [{ path: '', filename, library_id: libraryId, deleted_at: null }],
  stages: {},
});

function frame(timestampSec: number, byte: number): SampledFrame {
  return { timestampSec, jpeg: Buffer.from([byte]) };
}

const THREE_FRAMES: SampledFrame[] = [frame(0, 1), frame(2, 2), frame(4, 3)];

function validResponseFor(frames: readonly SampledFrame[]): string {
  return JSON.stringify({
    summary: 'A short clip.',
    scenes: frames.map((_, i) => ({
      frame_index: i,
      caption: `caption ${i}`,
      text_visible: null,
    })),
  });
}

afterEach(() => {
  setVideoDescribeDepsForTests(null);
  setLibraryRootsForTests(null);
});

interface InjectOptions {
  frames?: SampledFrame[];
  describeImpl?: (frames: readonly Buffer[]) => Promise<{
    result: { text: string; cost_usd: number; provider_info: Record<string, string> };
    server: { url: string };
  }>;
  sampleFailureReason?: 'no-video-decoder' | 'no-decodable-frame';
}

function inject(opts: InjectOptions = {}): { calls: Array<readonly Buffer[]> } {
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), '/lib']]));
  const calls: Array<readonly Buffer[]> = [];
  const frames = opts.frames ?? THREE_FRAMES;
  const defaultDescribe = async (sent: readonly Buffer[]) => ({
    result: {
      text: validResponseFor(frames.slice(0, sent.length)),
      cost_usd: 0,
      provider_info: {},
    },
    server: { url: 'http://gpu-box:11434' },
  });
  const impl = opts.describeImpl ?? defaultDescribe;
  // Every call — success or throw — is recorded here, regardless of which
  // implementation ran, so a test asserting on `calls` never has to
  // remember to record it itself.
  const recordingDescribe = async (sent: readonly Buffer[]) => {
    calls.push(sent);
    return impl(sent);
  };
  setVideoDescribeDepsForTests({
    sampleFrames: async () =>
      opts.sampleFailureReason
        ? { ok: false, reason: opts.sampleFailureReason }
        : { ok: true, frames, candidateCount: frames.length * 4, samplingMs: 123 },
    describe: recordingDescribe,
    model: 'gemma4:12b',
  } as never);
  return { calls };
}

describe('video-describe stage config', () => {
  it('claims only video assets, never audio-only or photo files (#3492)', () => {
    expect(videoDescribeStage.claimResidual?.params).toEqual(['video']);
    expect(videoDescribeStage.claimResidual?.sql).toContain('id = stage_state.asset_id');
    expect(videoDescribeStage.claimResidual?.sql).toContain('media_kind = ?');
  });

  it('leads the residual with the term that selects the partial index (#3795)', () => {
    // Two terms, because SQLite will not infer the `IN` that selects
    // `stage_claim_media` from the equality that narrows within it — see
    // `STAGE_STATE_VIDEO_NARROWING`. Asserted against the constant so the
    // stage cannot drift from the index the constant is spelled for.
    expect(videoDescribeStage.claimResidual?.sql.startsWith(STAGE_STATE_VIDEO_NARROWING)).toBe(
      true,
    );
  });

  it('depends on preview, starts paused-on-first-boot at concurrency 1', () => {
    expect(videoDescribeStage.dependsOn).toEqual(['preview']);
    expect(videoDescribeStage.defaults.concurrency).toBe(1);
    expect(videoDescribeStage.defaults.pausedOnFirstBoot).toBe(true);
    expect(videoDescribeStage.defaults.paused).toBe(false);
  });

  it('bumps its own targetVersion in lockstep with the prompt (version gating)', () => {
    // A brand-new stage: targetVersion 1 pairs with prompt version 1. The
    // convention (mirrored from `describe.ts`) is that any future prompt
    // edit bumps BOTH together so every existing row re-runs.
    expect(videoDescribeStage.targetVersion).toBe(1);
  });
});

describe('video-describe handler', () => {
  it('skips a non-video asset defensively (claimResidual already narrows this)', async () => {
    inject();
    const result = await videoDescribeHandler(asset('photo.jpg') as never, {} as never);
    expect(result).toEqual({ skip: 'not-video' });
  });

  it('skips when the library root cannot be resolved', async () => {
    inject();
    setLibraryRootsForTests(new Map()); // library no longer registered
    const result = await videoDescribeHandler(asset('clip.mp4') as never, {} as never);
    expect(result).toEqual({ skip: 'no-resolvable-location' });
  });

  it('forwards a terminal sampling failure as the matching skip reason', async () => {
    inject({ sampleFailureReason: 'no-video-decoder' });
    const result = await videoDescribeHandler(asset('clip.mp4') as never, {} as never);
    expect(result).toEqual({ skip: 'no-video-decoder' });
  });

  it('sends every sampled frame in order and maps scenes back to real timestamps', async () => {
    const { calls } = inject({ frames: THREE_FRAMES });
    const result = await videoDescribeHandler(asset('clip.mp4') as never, {} as never);

    expect(calls).toHaveLength(1);
    // Frame count + ordering: the bytes sent match the sampled frames,
    // in the same order.
    expect(calls[0]!.map((b) => b[0])).toEqual([1, 2, 3]);

    const description = patchedVideoDescription(result) as {
      summary: string;
      scenes: Array<{ timestamp_ms: number }>;
    };
    expect(description.scenes.map((s) => s.timestamp_ms)).toEqual([0, 2000, 4000]);

    const meta = patchedVideoMeta(result);
    expect(meta.frame_count).toBe(3);
    expect(meta.fallback_level).toBe('full');
    expect(meta.server_url).toBe('http://gpu-box:11434');
    expect((result as unknown as { invalidates: string[] }).invalidates).toEqual(['meili']);
  });

  it('degrades to every-other-frame on a terminal provider rejection, then succeeds', async () => {
    let attempt = 0;
    const { calls } = inject({
      frames: THREE_FRAMES,
      describeImpl: async (sent) => {
        attempt += 1;
        if (attempt === 1) {
          throw new RemoteError('too many images', false, 400);
        }
        return {
          result: {
            text: validResponseFor(THREE_FRAMES.slice(0, sent.length)),
            cost_usd: 0,
            provider_info: {},
          },
          server: { url: 'http://gpu-box:11434' },
        };
      },
    });

    const result = await videoDescribeHandler(asset('clip.mp4') as never, {} as never);
    expect(calls).toHaveLength(2);
    // Every-other-frame from 3 frames = frames at index 0 and 2.
    expect(calls[1]!.map((b) => b[0])).toEqual([1, 3]);

    const meta = patchedVideoMeta(result);
    expect(meta.fallback_level).toBe('reduced');
    expect(meta.frame_count).toBe(2);
  });

  it('degrades all the way to a single poster frame when every reduced attempt is also rejected', async () => {
    const { calls } = inject({
      frames: THREE_FRAMES,
      describeImpl: async (sent) => {
        if (sent.length > 1) throw new RemoteError('rejected', false, 400);
        return {
          result: { text: validResponseFor([THREE_FRAMES[0]!]), cost_usd: 0, provider_info: {} },
          server: { url: 'http://gpu-box:11434' },
        };
      },
    });

    const result = await videoDescribeHandler(asset('clip.mp4') as never, {} as never);
    // full (3 frames) rejected, reduced (2 frames) rejected, poster-only (1) succeeds.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toHaveLength(1);
    const meta = patchedVideoMeta(result);
    expect(meta.fallback_level).toBe('poster-only');
    expect(meta.frame_count).toBe(1);
  });

  it('propagates a terminal rejection unchanged when only one frame was ever sent', async () => {
    inject({
      frames: [frame(0, 1)],
      describeImpl: async () => {
        throw new RemoteError('rejected', false, 400);
      },
    });
    await expect(
      videoDescribeHandler(asset('clip.mp4') as never, {} as never),
    ).rejects.toBeInstanceOf(RemoteError);
  });

  it('propagates a retryable (transport) error immediately, without trying the degradation ladder', async () => {
    const { calls } = inject({
      frames: THREE_FRAMES,
      describeImpl: async () => {
        throw new RemoteError('timeout', true);
      },
    });
    await expect(videoDescribeHandler(asset('clip.mp4') as never, {} as never)).rejects.toThrow(
      'timeout',
    );
    expect(calls).toHaveLength(1); // no fallback attempts for a retryable failure
  });

  it('propagates a non-RemoteError (e.g. a raw network failure) immediately too', async () => {
    const { calls } = inject({
      frames: THREE_FRAMES,
      describeImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await expect(videoDescribeHandler(asset('clip.mp4') as never, {} as never)).rejects.toThrow(
      'ECONNRESET',
    );
    expect(calls).toHaveLength(1);
  });
});
