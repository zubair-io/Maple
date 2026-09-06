import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwoPhaseRenderScheduler } from './image-canvas.two-phase';

describe('native-detail refine scheduling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const host = {
      currentGeneration: () => 1,
      fastTargetPx: () => 800,
      refineTargetPx: (): number | null => null,
      gpuActive: () => false,
      runRender: vi.fn(async () => {}),
      tryNativeDetail: vi.fn(async (_xmp: string, _generation: number) => true),
    };
    return { host, scheduler: new TwoPhaseRenderScheduler(host) };
  }

  it('attempts a viewport patch even when the base target cannot grow', async () => {
    const { host, scheduler } = setup();
    scheduler.scheduleRefine('one', 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(host.tryNativeDetail).toHaveBeenCalledWith('one', 1);
    expect(host.runRender).not.toHaveBeenCalled();
  });

  it('waits for a slow fast render to provide the exact base anchors', async () => {
    const { host, scheduler } = setup();
    let finish!: () => void;
    host.runRender.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    scheduler.schedule('edited', 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(host.tryNativeDetail).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.tryNativeDetail).toHaveBeenCalledWith('edited', 1);
    expect(host.runRender).toHaveBeenCalledTimes(1);
  });

  it('coalesces panning to one in-flight request and the latest waiting view', async () => {
    const { host, scheduler } = setup();
    let finish!: (value: boolean) => void;
    host.tryNativeDetail.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    scheduler.scheduleRefine('first', 1);
    await vi.advanceTimersByTimeAsync(150);
    scheduler.scheduleRefine('middle', 1);
    await vi.advanceTimersByTimeAsync(150);
    scheduler.scheduleRefine('last', 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(host.tryNativeDetail).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.tryNativeDetail.mock.calls.map((c) => c[0])).toEqual(['first', 'last']);
  });

  it('uses the full-image fallback for unsupported patches but never for a superseded reply', async () => {
    const { host, scheduler } = setup();
    host.refineTargetPx = () => 6000;
    host.tryNativeDetail.mockResolvedValue(false);
    scheduler.scheduleRefine('one', 1);
    await vi.advanceTimersByTimeAsync(150);
    expect(host.runRender).toHaveBeenCalledWith('one', 1, {
      maxLongEdge: 6000,
      qualityPreview: false,
    });
    host.runRender.mockClear();
    let finish!: (value: boolean) => void;
    host.tryNativeDetail.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    scheduler.scheduleRefine('two', 1);
    await vi.advanceTimersByTimeAsync(150);
    scheduler.clear();
    finish(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.runRender).not.toHaveBeenCalled();
  });

  it('never requests native detail on the GPU path', async () => {
    const { host, scheduler } = setup();
    host.gpuActive = () => true;
    scheduler.scheduleRefine('one', 1);
    await vi.advanceTimersByTimeAsync(300);
    expect(host.tryNativeDetail).not.toHaveBeenCalled();
  });
});
