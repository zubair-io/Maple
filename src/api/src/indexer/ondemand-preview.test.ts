import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetOndemandPreviewsForTests, ondemandPreviews } from './ondemand-preview.ts';
import {
  isPreviewInteractiveMessage,
  isPreviewStageRenderMessage,
  type PreviewInteractiveMessage,
} from './preview-priority-protocol.ts';

afterEach(() => _resetOndemandPreviewsForTests());

describe('ondemandPreviews worker channel (#5433)', () => {
  it('tells a newly attached worker the current state, then only the changes', () => {
    const sent: PreviewInteractiveMessage[] = [];
    ondemandPreviews().attachWorker((message) => sent.push(message));
    expect(sent).toEqual([{ type: 'preview-interactive', active: false }]);
  });

  it('stops waiting for a stage render when the worker goes away', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maple-ondemand-'));
    try {
      const source = join(dir, 'a.jpg');
      const previewPath = join(dir, '.maple', 'previews', 'a.jpg.avif');
      await writeFile(source, 'source');
      const renderer = ondemandPreviews();
      renderer.attachWorker(() => {});
      renderer.onStageRender({
        type: 'preview-stage-render',
        previewPath,
        phase: 'start',
      });

      let settled = false;
      const pending = renderer.render(source, previewPath).then(() => {
        settled = true;
      });
      await Bun.sleep(20);
      expect(settled).toBe(false);

      // The stage finished the file just before the worker died; the request
      // finds it fresh and renders nothing.
      await mkdir(join(dir, '.maple', 'previews'), { recursive: true });
      await writeFile(previewPath, 'stage-render');
      renderer.detachWorker();
      await pending;
      expect(settled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recognises only well-formed messages', () => {
    expect(
      isPreviewInteractiveMessage({
        type: 'preview-interactive',
        active: true,
      }),
    ).toBe(true);
    expect(isPreviewInteractiveMessage({ type: 'preview-interactive' })).toBe(false);
    expect(
      isPreviewStageRenderMessage({
        type: 'preview-stage-render',
        previewPath: '/p',
        phase: 'end',
      }),
    ).toBe(true);
    expect(
      isPreviewStageRenderMessage({
        type: 'preview-stage-render',
        previewPath: '/p',
        phase: 'x',
      }),
    ).toBe(false);
    expect(isPreviewStageRenderMessage(null)).toBe(false);
  });
});
