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
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import type { ImageDoc } from '../run-stage.ts';
import type {
  DescribeProvider,
  DescribeResult,
} from '../../enrichment/describe-providers/index.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';

/** A fully-populated VisionDoc as qwen would return it for a real photo.
 * Spread-and-override this rather than hand-rolling partial docs, so a new
 * required field lands in every suite at once. */
export const VALID_VISION = {
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
 * provider (#1978), so a placeholder byte sequence would make `sharp()`
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
