import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetOndemandPreviewsForTests, ondemandPreviews } from './ondemand-preview.ts';
import {
  isPreviewInteractiveMessage,
  isPreviewPriorityReadyMessage,
  isPreviewStageRenderMessage,
  type PreviewInteractiveMessage,
} from './preview-priority-protocol.ts';

afterEach(() => _resetOndemandPreviewsForTests());

describe('ondemandPreviews worker channel (#5433)', () => {
  it('tells a newly attached worker the current state, then only the changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maple-ondemand-'));
    try {
      const source = join(dir, 'a.jpg');
      const previewPath = join(dir, '.maple', 'previews', 'a.jpg.avif');
      await writeFile(source, 'source');
      await mkdir(join(dir, '.maple', 'previews'), { recursive: true });
      await writeFile(previewPath, 'cached');
      const sent: PreviewInteractiveMessage[] = [];
      const renderer = ondemandPreviews();
      renderer.attachWorker((message) => sent.push(message));
      await Promise.all([
        renderer.render(source, previewPath),
        renderer.render(source, previewPath),
      ]);
      expect(sent.map((m) => m.active)).toEqual([false, true, false]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps waiting while a second stage render of the same path is still running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maple-ondemand-'));
    try {
      const source = join(dir, 'b.jpg');
      const previewPath = join(dir, '.maple', 'previews', 'b.jpg.avif');
      await writeFile(source, 'source');
      await mkdir(join(dir, '.maple', 'previews'), { recursive: true });
      const renderer = ondemandPreviews();
      const start = { type: 'preview-stage-render', previewPath, phase: 'start' } as const;
      const end = { ...start, phase: 'end' } as const;
      renderer.onStageRender(start);
      renderer.onStageRender(start);
      let settled = false;
      const pending = renderer.render(source, previewPath).then(() => {
        settled = true;
      });
      renderer.onStageRender(end);
      await Bun.sleep(20);
      expect(settled).toBe(false);
      await writeFile(previewPath, 'stage-render');
      renderer.onStageRender(end);
      await pending;
      expect(settled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    expect(isPreviewPriorityReadyMessage({ type: 'preview-priority-ready' })).toBe(true);
    expect(isPreviewPriorityReadyMessage(undefined)).toBe(false);
  });
});
