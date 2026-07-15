import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
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

describe('describeHandler — preview missing', () => {
  it("returns { skip: 'preview-missing' } when the 1280-px preview is absent", async () => {
    const absPath = join(tmpRoot, 'no-preview.dng');
    // No seedPreview call — the file doesn't exist.
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
    expect('skip' in result).toBe(true);
    expect((result as { skip: string }).skip).toBe('preview-missing');
  });
});

describe('describeHandler — video files are not described', () => {
  it("returns { skip: 'stub-file' } for a .MOV without calling the provider", async () => {
    const absPath = join(tmpRoot, 'IMG_3087.MOV');
    // Stage a preview on disk so we prove the skip fires on extension alone,
    // not because the preview is missing.
    const doc = await stageDoc(absPath);
    let called = false;
    const provider: DescribeProvider = {
      name: 'ollama',
      async describe(): Promise<DescribeResult> {
        called = true;
        throw new Error('provider should not be called for a video file');
      },
      async health(): Promise<void> {},
    };
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });

    const result = await describeHandler(doc, fakeCtx);
    expect((result as { skip: string }).skip).toBe('stub-file');
    expect(called).toBe(false);
  });

  it('matches the extension case-insensitively (.mp4 lowercase)', async () => {
    const absPath = join(tmpRoot, 'clip.mp4');
    const doc = await stageDoc(absPath);
    const provider = mockProvider(new Error('must not run'));
    setDescribeDepsForTests({
      provider,
      systemPrompt: 'p',
      model: 'qwen3-vl:8b',
    });
    const result = await describeHandler(doc, fakeCtx);
    expect((result as { skip: string }).skip).toBe('stub-file');
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
