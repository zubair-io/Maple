import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { ffiPool } from '../ffi/ffi-pool.ts';
import {
  _backgroundRendersRunning,
  _resetBackgroundRenderGateForTests,
  runBackgroundRender,
  setInteractivePreviewActive,
} from './background-render-gate.ts';
import type { PreviewStageRenderMessage } from '../indexer/preview-priority-protocol.ts';

const originalSend = process.send;
let sent: PreviewStageRenderMessage[] = [];

beforeEach(() => {
  _resetBackgroundRenderGateForTests();
  sent = [];
  process.send = ((message: PreviewStageRenderMessage) => {
    sent.push(message);
    return true;
  }) as typeof process.send;
});

afterEach(() => {
  process.send = originalSend;
  _resetBackgroundRenderGateForTests();
});

function capacity(): number {
  return ffiPool().poolSize();
}

describe('background render gate (#5433, #6020)', () => {
  it('admits no more renders than the FFI pool can execute', async () => {
    const release = Promise.withResolvers<void>();
    let peak = 0;
    const renders = Array.from({ length: capacity() + 3 }, (_, i) =>
      runBackgroundRender(async () => {
        peak = Math.max(peak, _backgroundRendersRunning());
        await release.promise;
      }, `/p/${i}.avif`),
    );
    await Bun.sleep(10);
    expect(_backgroundRendersRunning()).toBe(capacity());
    release.resolve();
    await Promise.all(renders);
    expect(peak).toBe(capacity());
    expect(_backgroundRendersRunning()).toBe(0);
  });

  it('holds new renders while an on-demand render is pending, and resumes when it ends', async () => {
    setInteractivePreviewActive(true);
    let started = false;
    const render = runBackgroundRender(async () => {
      started = true;
    }, '/p/held.avif');
    await Bun.sleep(30);
    expect(started).toBe(false);
    setInteractivePreviewActive(false);
    await render;
    expect(started).toBe(true);
  });

  it('announces each render to the API process, ending even when the render throws', async () => {
    await runBackgroundRender(async () => {}, '/p/ok.avif');
    await runBackgroundRender(async () => {
      throw new Error('render failed');
    }, '/p/bad.avif').catch(() => {});
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
    expect(_backgroundRendersRunning()).toBe(0);
  });

  it('announces nothing for a render without an announce path', async () => {
    await runBackgroundRender(async () => {});
    expect(sent).toEqual([]);
  });

  it('holds a RAW thumbnail render while an on-demand preview is pending', async () => {
    setInteractivePreviewActive(true);
    let started = false;
    const render = runBackgroundRender(async () => {
      started = true;
    });
    await Bun.sleep(30);
    expect(started).toBe(false);
    setInteractivePreviewActive(false);
    await render;
    expect(started).toBe(true);
  });

  it('shares its admission cap between preview and thumbnail renders', async () => {
    const release = Promise.withResolvers<void>();
    const renders = Array.from({ length: capacity() + 2 }, (_, i) =>
      i % 2 === 0
        ? runBackgroundRender(() => release.promise, `/p/${i}.avif`)
        : runBackgroundRender(() => release.promise),
    );
    await Bun.sleep(10);
    expect(_backgroundRendersRunning()).toBe(capacity());
    release.resolve();
    await Promise.all(renders);
  });

  it('stops yielding after the cap when an inactive message never arrives', async () => {
    jest.useFakeTimers();
    try {
      setInteractivePreviewActive(true);
      let started = false;
      const render = runBackgroundRender(async () => {
        started = true;
      });
      jest.advanceTimersByTime(9_999);
      await Promise.resolve();
      expect(started).toBe(false);
      jest.advanceTimersByTime(2);
      await render;
      expect(started).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
