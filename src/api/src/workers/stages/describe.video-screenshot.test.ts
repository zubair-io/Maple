/**
 * `is_screenshot` is a stills-only concept (#2325), and the describe stage is
 * the write site that matters most for video: a clip gets a real poster-frame
 * preview (#1649), so its frame reaches qwen2.5-vl, and the model returns
 * `is_screenshot: true` for anything that looks like a user interface — a
 * screen recording every time.
 *
 * The verdict has THREE consumers and each is pinned separately here, because
 * clamping only the obvious one leaves a live path back:
 *   - the top-level `is_screenshot` mirror (what search and the
 *     Photos/Screenshots filter read),
 *   - the copy stored inside the `vision` subdoc (which
 *     `sidecar-metadata-index` reads back as its FIRST source of truth, so an
 *     unclamped one resurrects the flag on the next sidecar re-index),
 *   - the `relocateBackupScreenshot` call, which moves the file on disk into
 *     `<year>/Screenshot`.
 *
 * Lives in its own file rather than in `describe.test.ts` because that file
 * hit the 600-line hard budget; shared scaffolding is in `describe.fixtures.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ObjectId } from 'mongodb';
import { setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import * as refileBackups from '../migration/refile-backups.ts';
import { describeHandler, setDescribeDepsForTests } from './describe.ts';
import { VALID_VISION, mockProvider, stageDocIn } from './describe.fixtures.ts';

let tmpRoot: string;
let libraryId: ObjectId;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'maple-describe-screenshot-'));
  libraryId = new ObjectId();
  setLibraryRootsForTests(new Map([[libraryId.toHexString(), tmpRoot]]));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  setDescribeDepsForTests(null);
  setLibraryRootsForTests(null);
});

const fakeCtx = {} as never;

/** A video's poster frame reads as a UI to the VLM. */
const SCREENSHOT_VISION = { ...VALID_VISION, is_screenshot: true };

function withScreenshotVerdict() {
  setDescribeDepsForTests({
    provider: mockProvider({
      text: JSON.stringify(SCREENSHOT_VISION),
      cost_usd: 0,
      provider_info: {},
    }),
    systemPrompt: 'structured vision prompt',
    model: 'qwen3-vl:8b',
  });
}

describe('describeHandler — video is never a screenshot (#2325)', () => {
  it('writes is_screenshot false for a video even when the model says true', async () => {
    const doc = await stageDocIn(join(tmpRoot, 'clip.mov'), libraryId, tmpRoot);
    withScreenshotVerdict();

    const res = (await describeHandler(doc, fakeCtx)) as { patch: Record<string, unknown> };

    expect(res.patch.is_screenshot).toBe(false);
  });

  it('also clamps the stored vision subdoc, so a sidecar re-index cannot resurrect it', async () => {
    const doc = await stageDocIn(join(tmpRoot, 'clip.mov'), libraryId, tmpRoot);
    withScreenshotVerdict();

    const res = (await describeHandler(doc, fakeCtx)) as {
      patch: { vision: { is_screenshot: boolean; caption: string } };
    };

    expect(res.patch.vision.is_screenshot).toBe(false);
    // The rest of the VisionDoc is passed through untouched.
    expect(res.patch.vision.caption).toBe(VALID_VISION.caption);
  });

  it('never relocates a video into <year>/Screenshot on disk', async () => {
    const doc = await stageDocIn(join(tmpRoot, 'clip.mov'), libraryId, tmpRoot);
    // The relocation is gated on backup origin, so give the doc a phasset
    // link — otherwise this test would pass for the wrong reason.
    (doc as unknown as { phasset_links: string[] }).phasset_links = ['SS/L0/001'];
    const relocate = spyOn(refileBackups, 'relocateBackupScreenshot');
    withScreenshotVerdict();

    await describeHandler(doc, fakeCtx);

    expect(relocate).not.toHaveBeenCalled();
    relocate.mockRestore();
  });

  it('still honours a true verdict for a still image', async () => {
    const doc = await stageDocIn(join(tmpRoot, 'shot.png'), libraryId, tmpRoot);
    withScreenshotVerdict();

    const res = (await describeHandler(doc, fakeCtx)) as {
      patch: { is_screenshot: boolean; vision: { is_screenshot: boolean } };
    };

    expect(res.patch.is_screenshot).toBe(true);
    expect(res.patch.vision.is_screenshot).toBe(true);
  });
});
