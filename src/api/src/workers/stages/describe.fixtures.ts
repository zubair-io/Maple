/**
 * Shared test fixtures for the describe-stage suites.
 *
 * Extracted from `describe.test.ts` when that file crossed the 600-line hard
 * budget (#2325). Two suites now exercise the same handler from different
 * angles — the main behavioural bank in `describe.test.ts` and the
 * screenshot-clamp bank in `describe.video-screenshot.test.ts` — and both
 * need the same doc/provider/preview scaffolding. Keeping ONE definition
 * means a change to the ImageDoc shape or the preview-staging convention
 * can't fix one suite and silently leave the other asserting against a stale
 * fixture.
 *
 * Named `.fixtures.ts`, not `.test-helpers.ts`, so bun's `*.test.ts` glob
 * doesn't try to run it as a suite. Mirrors
 * `workers/migration/video-geo-backfill.fixtures.ts`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ObjectId } from '../../db/object-id.ts';
import { solidAvif } from '../../test-support/synth-image.ts';
import type { VisionDoc } from '../../db/schema.ts';
import type { ImageDoc, StageResult } from '../run-stage.ts';
import type {
  DescribeProvider,
  DescribeResult,
} from '../../enrichment/describe-providers/index.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { DescribeServerPool } from '../../enrichment/describe-server-pool.ts';

/** A fully-populated VisionDoc as the model would return it for a real
 * photo. Spread-and-override this rather than hand-rolling partial docs, so
 * a new required field lands in every suite at once — the `VisionDoc`
 * annotation is what makes that promise enforceable, since without it a
 * field added to the schema type would leave this literal silently stale. */
export const VALID_VISION: VisionDoc = {
  is_screenshot: false,
  people_count: 0,
  nudity: 'none',
  caption: 'A red bicycle leaning against a brick wall.',
  tags: ['bicycle', 'red', 'brick wall', 'alleyway', 'outdoor', 'parked'],
  subjects: ['vehicle'],
  scene_type: 'outdoor',
  setting: 'alleyway',
  activity: null,
  time_of_day: 'afternoon',
  lighting: 'natural',
  weather: 'clear',
  mood: 'calm',
  colors: ['red', 'brown', 'grey'],
  framing: 'close-up',
  text_visible: null,
  notable_objects: ['bicycle', 'brick wall'],
  shot_type: 'static',
};

/** An ImageDoc whose single fileinfo entry points at `absPath` inside
 * `libraryRoot`. The relative dir is derived, not passed, so the doc always
 * agrees with the path the preview cache will be keyed on. */
export function fakeDoc(absPath: string, libraryId: ObjectId, libraryRoot: string): ImageDoc {
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

/** A DescribeProvider that returns a canned result, or throws a canned
 * error, on every call. */
export function mockProvider(result: DescribeResult | Error): DescribeProvider {
  return {
    name: 'ollama',
    async describe(_bytes, _opts): Promise<DescribeResult> {
      if (result instanceof Error) throw result;
      return result;
    },
    async health(): Promise<void> {},
  };
}

/** Stage a fake 1280-px preview AND build the matching doc. The doc's
 * fileinfo determines the (path-keyed) preview cache path so we have to
 * construct them together. The preview must be a genuinely decodable AVIF —
 * `describeHandler` decodes + re-encodes it to JPEG before calling the
 * provider (#1978), so a placeholder byte sequence would make `maple()`
 * throw instead of exercising the real path. */
export async function stageDocIn(
  absPath: string,
  libraryId: ObjectId,
  tmpRoot: string,
): Promise<ImageDoc> {
  const doc = fakeDoc(absPath, libraryId, tmpRoot);
  const previewPath = cachePathForAsset(
    doc as never,
    new Map([[libraryId.toHexString(), tmpRoot]]),
    'previews',
    'avif',
  );
  if (!previewPath) throw new Error('test setup: cachePathForAsset returned null');
  mkdirSync(dirname(previewPath), { recursive: true });
  const avifBytes = await solidAvif(32, 24, [120, 80, 40]);
  writeFileSync(previewPath, avifBytes);
  return doc;
}

/** Wrap a mock provider in a one-server pool so a suite can keep asserting
 * against the provider it built while the handler goes through the real
 * admission/failover path. Concurrency 1 keeps calls serialized, which is
 * what the single-asset cases assume. */
export function singleServerPool(provider: DescribeProvider): DescribeServerPool {
  return new DescribeServerPool(
    [{ url: 'http://localhost:11434', concurrency: 1 }],
    () => provider,
  );
}

/**
 * What a describe handler asked the runner to write, back in the field names
 * the document patch used.
 *
 * The patch is two statements now — the `asset_detail` upsert carrying the
 * caption, the structured vision and the OCR mirror, and the one-column
 * `assets` UPDATE for the screenshot verdict the grid filters on — so the
 * assertions decode bound parameters instead of reading properties. Decoding
 * once here rather than in each suite keeps those tests about describe's
 * output and not about the schema's table split.
 */
export function patchFields(result: StageResult): Record<string, unknown> {
  if (!('patch' in result)) throw new Error(`expected a patch, got ${JSON.stringify(result)}`);
  const detail = result.patch.find((s) => s.sql.includes('INSERT INTO asset_detail'));
  const screenshot = result.patch.find((s) => s.sql.includes('is_screenshot = ?'));
  if (detail === undefined || screenshot === undefined) {
    throw new Error('expected a detail upsert and a screenshot update in the patch');
  }
  const [description, descriptionMeta, ocrText, ocrMeta, vision, visionMeta] =
    detail.params as string[];
  return {
    description,
    description_meta: JSON.parse(descriptionMeta!) as unknown,
    ocr_text: ocrText,
    ocr_meta: JSON.parse(ocrMeta!) as unknown,
    vision: JSON.parse(vision!) as unknown,
    vision_meta: JSON.parse(visionMeta!) as unknown,
    is_screenshot: (screenshot.params as unknown[])[0] === 1,
  };
}
