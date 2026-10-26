import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ffiPool } from '../ffi/ffi-pool.ts';
import {
  _backgroundPreviewRendersRunning,
  _resetBackgroundPreviewGateForTests,
  runBackgroundPreviewRender,
  setInteractivePreviewActive,
} from './background-preview-gate.ts';
import type { PreviewStageRenderMessage } from '../indexer/preview-priority-protocol.ts';

const originalSend = process.send;
let sent: PreviewStageRenderMessage[] = [];

beforeEach(() => {
  _resetBackgroundPreviewGateForTests();
  sent = [];
  process.send = ((message: PreviewStageRenderMessage) => {
    sent.push(message);
    return true;
  }) as typeof process.send;
});

afterEach(() => {
  process.send = originalSend;
  _resetBackgroundPreviewGateForTests();
});

function capacity(): number {
  const stats = ffiPool().stats();
  return stats.target + stats.bitmap.target;
}

describe('background preview gate (#5433)', () => {
  it('admits no more renders than the FFI pool can execute', async () => {
    const release = Promise.withResolvers<void>();
    let peak = 0;
    const renders = Array.from({ length: capacity() + 3 }, (_, i) =>
      runBackgroundPreviewRender(`/p/${i}.avif`, async () => {
        peak = Math.max(peak, _backgroundPreviewRendersRunning());
        await release.promise;
      }),
    );
    await Bun.sleep(10);
    expect(_backgroundPreviewRendersRunning()).toBe(capacity());
    release.resolve();
    await Promise.all(renders);
    expect(peak).toBe(capacity());
    expect(_backgroundPreviewRendersRunning()).toBe(0);
  });

  it('holds new renders while an on-demand render is pending, and resumes when it ends', async () => {
    setInteractivePreviewActive(true);
    let started = false;
    const render = runBackgroundPreviewRender('/p/held.avif', async () => {
      started = true;
    });
    await Bun.sleep(30);
    expect(started).toBe(false);
    setInteractivePreviewActive(false);
    await render;
    expect(started).toBe(true);
  });

  it('announces each render to the API process, ending even when the render throws', async () => {
    await runBackgroundPreviewRender('/p/ok.avif', async () => {});
    await runBackgroundPreviewRender('/p/bad.avif', async () => {
      throw new Error('render failed');
    }).catch(() => {});
    expect(sent).toEqual([
      {
        type: 'preview-stage-render',
        previewPath: '/p/ok.avif',
        phase: 'start',
      },
      { type: 'preview-stage-render', previewPath: '/p/ok.avif', phase: 'end' },
      {
        type: 'preview-stage-render',
        previewPath: '/p/bad.avif',
        phase: 'start',
      },
      {
        type: 'preview-stage-render',
        previewPath: '/p/bad.avif',
        phase: 'end',
      },
    ]);
    expect(_backgroundPreviewRendersRunning()).toBe(0);
  });
});
