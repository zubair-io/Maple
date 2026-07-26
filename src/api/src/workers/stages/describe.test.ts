import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import type { ImageDoc } from '../run-stage.ts';
import {
  RemoteError,
  type DescribeProvider,
  type DescribeResult,
} from '../../enrichment/describe-providers/index.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import * as refileBackups from '../migration/refile-backups.ts';

import { describeHandler, setDescribeDepsForTests, DESCRIBE_PROMPT_VERSION } from './describe.ts';
import { VISION_DOC_JSON_SCHEMA } from '../../enrichment/describe-providers/parse-vision-json.ts';

const VALID_VISION = {
  is_screenshot: false,
  nudity: 'none',
  caption: 'A red bicycle leaning against a brick wall.',
  subjects: ['vehicle'],
  scene_type: 'outdoor',
  setting: 'alleyway',
  activity: null,
  time_of_day: 'afternoon',
  lighting: 'natural',
  weather: 'clear',
  mood: 'calm',
  colors: ['red', 'brown', 'grey'],
  composition: 'close-up',
  text_visible: null,
  notable_objects: ['bicycle', 'brick wall'],
  shot_type: 'static',
};

function fakeDoc(absPath: string, libraryId: ObjectId, libraryRoot: string): ImageDoc {
  const relDir = (() => {
    const r = absPath.startsWith(libraryRoot + '/')
      ? absPath.substring(libraryRoot.length + 1)
      : '';
    const lastSlash = r.lastIndexOf('/');
    return lastSlash < 0 ? '' : r.substring(0, lastSlash);
  })();
  const filename = absPath.split('/').pop()!;
  return {
    _id: new ObjectId(),
    fileinfo: [{ path: relDir, filename, library_id: libraryId, deleted_at: null }],
    maple_id: 'describe-test-' + Math.random().toString(36).slice(2),
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: new Date().toISOString(),
    exif: {
      captured_at: '2024-06-01T12:00:00.000Z',
      captured_year: 2024,
      captured_month: 6,
      camera_make: null,
      camera_model: null,
      lens: null,
      iso: null,
      aperture: null,
      shutter: null,
      focal_length: null,
      gps: null,
    },
    faces: [],
    description: null,
    place: null,
    stages: {},
  } as unknown as ImageDoc;
}

function mockProvider(result: DescribeResult | Error): DescribeProvider {
  return {
    name: 'ollama',
    async describe(_bytes, _opts): Promise<DescribeResult> {
      if (result instanceof Error) throw result;
      return result;
    },
    async health(): Promise<void> {},
  };
}

let tmpRoot: string;
let libraryId: ObjectId;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'maple-describe-stage-'));
  libraryId = new ObjectId();
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), tmpRoot]]));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  setDescribeDepsForTests(null);
  setLibraryRootsForTests(null);
});

/** Stage a fake 1280-px preview AND build the matching doc. The doc's
 * fileinfo determines the (path-keyed) preview cache path so we have to
 * construct them together. The preview must be a genuinely decodable AVIF —
 * `describeHandler` now decodes + re-encodes it to JPEG before calling the
 * provider (#1978), so a placeholder byte sequence would make `sharp()`
 * throw instead of exercising the real path. */
async function stageDoc(absPath: string): Promise<ImageDoc> {
  const doc = fakeDoc(absPath, libraryId, tmpRoot);
  const previewPath = cachePathForAsset(
    doc as never,
    new Map([[libraryId.toHexString(), tmpRoot]]),
    'previews',
    'avif',
  );
  if (!previewPath) throw new Error('test setup: cachePathForAsset returned null');
  mkdirSync(dirname(previewPath), { recursive: true });
  const avifBytes = await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: { r: 120, g: 80, b: 40 },
    },
  })
    .avif()
    .toBuffer();
  writeFileSync(previewPath, avifBytes);
  return doc;
}

const fakeCtx = {} as never;

describe('describeHandler — happy path', () => {
  it('returns patch with description, description_meta, vision, vision_meta', async () => {
    const absPath = join(tmpRoot, 'img.dng');
    const doc = await stageDoc(absPath);
    const provider = mockProvider({
      text: JSON.stringify(VALID_VISION),
      cost_usd: 0.0, // qwen3-vl runs locally; no spend
      provider_info: { eval_count: '30' },
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'structured vision prompt',
      model: 'qwen3-vl:8b',
    });

    const result = await describeHandler(doc, fakeCtx);
    const patch = (result as { patch: Record<string, unknown> }).patch;

    // Legacy description mirror is the caption verbatim.
    expect(patch.description).toBe(VALID_VISION.caption);

    // Structured vision subdoc round-trips.
    const vision = patch.vision as typeof VALID_VISION;
    expect(vision.subjects).toEqual(VALID_VISION.subjects);
    expect(vision.scene_type).toBe('outdoor');
    expect(vision.notable_objects).toEqual(VALID_VISION.notable_objects);

    // description_meta keeps its existing shape + provider_info spread.
    const meta = patch.description_meta as Record<string, unknown>;
    expect(meta.provider).toBe('ollama');
    expect(meta.model).toBe('qwen3-vl:8b');
    expect(meta.prompt_version).toBe(DESCRIBE_PROMPT_VERSION);
    expect(typeof meta.generated_at).toBe('string');
    expect(meta.eval_count).toBe('30');

    // vision_meta carries the same provenance plus raw_response_size.
    const vmeta = patch.vision_meta as Record<string, unknown>;
    expect(vmeta.provider).toBe('ollama');
    expect(vmeta.model).toBe('qwen3-vl:8b');
    expect(vmeta.prompt_version).toBe(DESCRIBE_PROMPT_VERSION);
    expect(typeof vmeta.raw_response_size).toBe('number');
    expect((vmeta.raw_response_size as number) > 0).toBe(true);

    // Top-level is_screenshot mirror — overwrites the exif heuristic.
    expect(patch.is_screenshot).toBe(false);

    // A describe success marks meili stale so the caption/OCR gets reindexed
    // — meili depends on exif+thumb only and usually ran long before (#2172).
    expect((result as { invalidates?: readonly string[] }).invalidates).toEqual(['meili']);
  });

  it('threads VISION_DOC_JSON_SCHEMA through to the provider as `format`', async () => {
    const absPath = join(tmpRoot, 'img.dng');
    const doc = await stageDoc(absPath);
    let capturedFormat: unknown = undefined;
    const provider: DescribeProvider = {
      name: 'ollama',
      async describe(_bytes, opts): Promise<DescribeResult> {
        capturedFormat = opts.format;
        return {
          text: JSON.stringify(VALID_VISION),
          cost_usd: 0,
          provider_info: {},
        };
      },
      async health(): Promise<void> {},
    };
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    await describeHandler(doc, fakeCtx);
    // Identity, not deep equality — the stage should pass the exported
    // schema constant verbatim, not a copy. Catches accidental rebuilds
    // (a `JSON.parse(JSON.stringify(...))` round-trip would drop the
    // `as const` typing and silently allow drift).
    expect(capturedFormat).toBe(VISION_DOC_JSON_SCHEMA);
  });

  it('writes is_screenshot: true at the top level when the VLM flags it', async () => {
    const absPath = join(tmpRoot, 'screenshot.png');
    const doc = await stageDoc(absPath);
    const vision = { ...VALID_VISION, is_screenshot: true };
    const provider = mockProvider({
      text: JSON.stringify(vision),
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });

    const result = await describeHandler(doc, fakeCtx);
    const patch = (result as { patch: Record<string, unknown> }).patch;
    expect(patch.is_screenshot).toBe(true);
    expect((patch.vision as { is_screenshot: boolean }).is_screenshot).toBe(true);
  });

  it('forgives a markdown-fence-wrapped model response', async () => {
    const absPath = join(tmpRoot, 'fenced.dng');
    const doc = await stageDoc(absPath);
    const provider = mockProvider({
      text: '```json\n' + JSON.stringify(VALID_VISION) + '\n```',
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    const patch = (result as { patch: Record<string, unknown> }).patch;
    expect(patch.description).toBe(VALID_VISION.caption);
  });
});

describe('describeHandler — parse failure', () => {
  it('throws on prose-only model output (runtime auto-dead-letters)', async () => {
    const absPath = join(tmpRoot, 'prose.dng');
    const doc = await stageDoc(absPath);
    const provider = mockProvider({
      text: 'Sorry, I cannot help with that.',
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    await expect(describeHandler(doc, fakeCtx)).rejects.toThrow('vision-parse');
  });

  it('throws on JSON with a missing required field', async () => {
    const absPath = join(tmpRoot, 'incomplete.dng');
    const doc = await stageDoc(absPath);
    const broken = { ...VALID_VISION } as Partial<typeof VALID_VISION>;
    // `caption` is the canonical strictly-required field — array-of-feature
    // fields (subjects/colors/notable_objects) and the enum fields are
    // tolerantly defaulted now when null/missing, so they no longer cover
    // "missing required field" rejection.
    delete broken.caption;
    const provider = mockProvider({
      text: JSON.stringify(broken),
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    await expect(describeHandler(doc, fakeCtx)).rejects.toThrow(/caption/);
  });
});

describe('describeHandler — preview missing (#2177)', () => {
  it('returns { rearm } when the preview stage wrote but its artefact has vanished', async () => {
    const absPath = join(tmpRoot, 'no-preview.dng');
    // No seedPreview call — the file doesn't exist, but the preview stage's
    // state says it ran cleanly (drift: moved cache dir, interrupted write).
    const doc = fakeDoc(absPath, libraryId, tmpRoot);
    doc.stages = {
      preview: { version: 4, attempts: 0, last_error: null, processed_at: null, dead: false },
    };
    const provider = mockProvider({
      text: JSON.stringify(VALID_VISION),
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    expect(result).toEqual({ rearm: { stage: 'preview', reason: 'preview-missing' } });
  });

  it('returns { rearm } when the preview stage has no recorded state at all', async () => {
    // The DAG-bug case: describe claimed a doc whose preview state is absent.
    // Re-arming is a no-op reset there, and the dependsOn gate holds describe
    // back until preview genuinely runs.
    const absPath = join(tmpRoot, 'no-state.dng');
    const doc = fakeDoc(absPath, libraryId, tmpRoot);
    const provider = mockProvider({
      text: JSON.stringify(VALID_VISION),
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    expect(result).toEqual({ rearm: { stage: 'preview', reason: 'preview-missing' } });
  });
});

// #1649 inverted this behaviour. Video used to be skipped on extension alone;
// now the preview stage renders a poster frame for it, so a clip is captioned
// from that poster like any still. What still must NOT happen is the vision
// model receiving container bytes — that's what OOM'd Ollama and motivated the
// original blanket skip. The protection is now positional rather than
// extension-based: describe only ever reads the preview artefact, and on a host
// with no ffmpeg the preview stage writes nothing, so the `preview-missing`
// branch fires instead. Both halves are asserted here.
describe('describeHandler — video files are described from their poster frame (#1649)', () => {
  it('describes a .MOV that has a poster-frame preview on disk', async () => {
    const absPath = join(tmpRoot, 'IMG_3087.MOV');
    // stageDoc seeds a real preview AVIF — standing in for what the preview
    // stage's ffmpeg branch writes for a video.
    const doc = await stageDoc(absPath);
    let called = false;
    const provider: DescribeProvider = {
      name: 'ollama',
      async describe(): Promise<DescribeResult> {
        called = true;
        return {
          text: JSON.stringify(VALID_VISION),
          cost_usd: 0,
          provider_info: {},
        };
      },
      async health(): Promise<void> {},
    };
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });

    const result = await describeHandler(doc, fakeCtx);
    expect(called).toBe(true);
    expect('patch' in result).toBe(true);
  });

  it('matches the extension case-insensitively (.mp4 lowercase)', async () => {
    const absPath = join(tmpRoot, 'clip.mp4');
    const doc = await stageDoc(absPath);
    const provider = mockProvider({
      text: JSON.stringify(VALID_VISION),
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    expect('patch' in result).toBe(true);
  });

  it("returns { skip: 'preview-missing' } for a video with no poster — the no-ffmpeg host", async () => {
    const absPath = join(tmpRoot, 'no-ffmpeg.mov');
    // No seedPreview: on a host without a runnable ffmpeg the preview stage
    // skips with 'no-video-decoder' and never writes this file. The provider
    // must not be reached — container bytes never go upstream. Because the
    // preview stage's own state records a terminal skip, re-arming it could
    // never produce a poster — so describe skips terminally rather than
    // returning { rearm } (#2177).
    const doc = fakeDoc(absPath, libraryId, tmpRoot);
    doc.stages = {
      preview: {
        version: 4,
        attempts: 0,
        last_error: 'skip: no-video-decoder',
        processed_at: null,
        dead: false,
      },
    };
    let called = false;
    const provider: DescribeProvider = {
      name: 'ollama',
      async describe(): Promise<DescribeResult> {
        called = true;
        throw new Error('provider must not be called without a poster frame');
      },
      async health(): Promise<void> {},
    };
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });

    const result = await describeHandler(doc, fakeCtx);
    expect((result as { skip: string }).skip).toBe('preview-missing');
    expect(called).toBe(false);
  });
});

describe('describeHandler — metadata-only stub images and audio are not described (#1835)', () => {
  it.each([
    'scan.eip',
    'session.braw',
    'project.afphoto',
    'logo.ai',
    'track.mp3',
    'voice.wav',
    'memo.m4a',
    'song.aac',
  ])("returns { skip: 'stub-file' } for %s without calling the provider", async (filename) => {
    const absPath = join(tmpRoot, filename);
    const doc = await stageDoc(absPath);
    const provider = mockProvider(new Error('provider should not be called'));
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    expect((result as { skip: string }).skip).toBe('stub-file');
  });
});

describe('describeHandler — provider errors', () => {
  it('a retryable RemoteError propagates', async () => {
    const absPath = join(tmpRoot, 'img2.dng');
    const doc = await stageDoc(absPath);
    const provider = mockProvider(new RemoteError('Provider 5xx: 503', true, 503));
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    await expect(describeHandler(doc, fakeCtx)).rejects.toThrow('503');
  });

  it('a non-retryable RemoteError propagates', async () => {
    const absPath = join(tmpRoot, 'img3.dng');
    const doc = await stageDoc(absPath);
    const provider = mockProvider(new RemoteError('Provider 4xx: 401', false, 401));
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    await expect(describeHandler(doc, fakeCtx)).rejects.toThrow('401');
  });
});

describe('describeHandler — OCR mirror from vision.text_visible', () => {
  it('writes ocr_text + ocr_meta when the asset has no prior ocr_meta', async () => {
    const absPath = join(tmpRoot, 'ocr-fresh.dng');
    const doc = await stageDoc(absPath);
    // No ocr_meta on the doc — describe should populate it.
    const vision = { ...VALID_VISION, text_visible: 'STOP' };
    const provider = mockProvider({
      text: JSON.stringify(vision),
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    const patch = (result as { patch: Record<string, unknown> }).patch;
    expect(patch.ocr_text).toBe('STOP');
    const ocrMeta = patch.ocr_meta as {
      engine: string;
      engine_version: string;
    };
    expect(ocrMeta.engine).toBe('qwen2.5-vl');
    expect(ocrMeta.engine_version).toBe('qwen3-vl:8b');
  });

  it('writes ocr_text as empty string when vision.text_visible is null', async () => {
    const absPath = join(tmpRoot, 'ocr-null.dng');
    const doc = await stageDoc(absPath);
    const vision = { ...VALID_VISION, text_visible: null };
    const provider = mockProvider({
      text: JSON.stringify(vision),
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    const patch = (result as { patch: Record<string, unknown> }).patch;
    expect(patch.ocr_text).toBe('');
  });

  it("unconditionally writes ocr_text + ocr_meta on refresh (vision wins; engine is the literal 'qwen2.5-vl')", async () => {
    const absPath = join(tmpRoot, 'ocr-refresh.dng');
    const doc = await stageDoc(absPath);
    // Prior ocr_meta of any shape on the doc is ignored — vision always wins.
    (doc as unknown as Record<string, unknown>).ocr_meta = {
      engine: 'qwen2.5-vl',
      engine_version: 'qwen2.5vl:7b',
      generated_at: '2026-05-01T00:00:00.000Z',
      mean_confidence: null,
    };
    const vision = { ...VALID_VISION, text_visible: 'FRESH READ' };
    const provider = mockProvider({
      text: JSON.stringify(vision),
      cost_usd: 0,
      provider_info: {},
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    const patch = (result as { patch: Record<string, unknown> }).patch;
    expect(patch.ocr_text).toBe('FRESH READ');
    const ocrMeta = patch.ocr_meta as { engine: 'qwen2.5-vl' };
    // Engine is the single literal — no union with other engines exists.
    expect(ocrMeta.engine).toBe('qwen2.5-vl');
  });
});

describe('describeHandler — provider_info extras', () => {
  it('spreads provider_info into description_meta', async () => {
    const absPath = join(tmpRoot, 'img4.dng');
    const doc = await stageDoc(absPath);
    const provider = mockProvider({
      text: JSON.stringify(VALID_VISION),
      cost_usd: 0.04,
      provider_info: { input_tokens: '120', output_tokens: '20' },
    });
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    const meta = (result as { patch: { description_meta: Record<string, unknown> } }).patch
      .description_meta;
    expect(meta.input_tokens).toBe('120');
    expect(meta.output_tokens).toBe('20');
    expect(meta.cost_usd).toBe(0.04);
  });
});

describe('describeHandler — video is never a screenshot (#2325)', () => {
  /** A video's poster frame reads as a UI to the VLM — a screen recording
   * does every time. The verdict must not reach any of its three consumers. */
  const SCREENSHOT_VISION = { ...VALID_VISION, is_screenshot: true };

  it('writes is_screenshot false for a video even when the model says true', async () => {
    const doc = await stageDoc(join(tmpRoot, 'clip.mov'));
    setDescribeDepsForTests({
      provider: mockProvider({
        text: JSON.stringify(SCREENSHOT_VISION),
        cost_usd: 0,
        provider_info: {},
      }),
      systemPrompt: 'structured vision prompt',
      model: 'qwen3-vl:8b',
    });

    const res = (await describeHandler(doc, fakeCtx)) as { patch: Record<string, unknown> };

    expect(res.patch.is_screenshot).toBe(false);
  });

  it('also clamps the stored vision subdoc, so a sidecar re-index cannot resurrect it', async () => {
    const doc = await stageDoc(join(tmpRoot, 'clip.mov'));
    setDescribeDepsForTests({
      provider: mockProvider({
        text: JSON.stringify(SCREENSHOT_VISION),
        cost_usd: 0,
        provider_info: {},
      }),
      systemPrompt: 'structured vision prompt',
      model: 'qwen3-vl:8b',
    });

    const res = (await describeHandler(doc, fakeCtx)) as {
      patch: { vision: { is_screenshot: boolean; caption: string } };
    };

    expect(res.patch.vision.is_screenshot).toBe(false);
    // The rest of the VisionDoc is passed through untouched.
    expect(res.patch.vision.caption).toBe(VALID_VISION.caption);
  });

  it('never relocates a video into <year>/Screenshot on disk', async () => {
    const doc = await stageDoc(join(tmpRoot, 'clip.mov'));
    // The relocation is gated on backup origin, so give the doc a phasset
    // link — otherwise this test would pass for the wrong reason.
    (doc as unknown as { phasset_links: string[] }).phasset_links = ['SS/L0/001'];
    const relocate = spyOn(refileBackups, 'relocateBackupScreenshot');

    setDescribeDepsForTests({
      provider: mockProvider({
        text: JSON.stringify(SCREENSHOT_VISION),
        cost_usd: 0,
        provider_info: {},
      }),
      systemPrompt: 'structured vision prompt',
      model: 'qwen3-vl:8b',
    });

    await describeHandler(doc, fakeCtx);

    expect(relocate).not.toHaveBeenCalled();
    relocate.mockRestore();
  });

  it('still honours a true verdict for a still image', async () => {
    const doc = await stageDoc(join(tmpRoot, 'shot.png'));
    setDescribeDepsForTests({
      provider: mockProvider({
        text: JSON.stringify(SCREENSHOT_VISION),
        cost_usd: 0,
        provider_info: {},
      }),
      systemPrompt: 'structured vision prompt',
      model: 'qwen3-vl:8b',
    });

    const res = (await describeHandler(doc, fakeCtx)) as {
      patch: { is_screenshot: boolean; vision: { is_screenshot: boolean } };
    };

    expect(res.patch.is_screenshot).toBe(true);
    expect(res.patch.vision.is_screenshot).toBe(true);
  });
});
