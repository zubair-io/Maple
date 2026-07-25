// TimelineThumbLoader — the bounded thumbnail request queue (#2219).
//
// The property under test is the one that broke Timeline on Self Hosted: a
// 200-row page used to fire 200 simultaneous /api/fs/thumb requests, and
// because the API speaks HTTP/1.1 the browser's 6-connection-per-origin cap
// left every other /api/* call queued behind them.

import { describe, it, expect, vi } from 'vitest';
import { MAX_CONCURRENT_THUMB_LOADS, TimelineThumbLoader } from './timeline-thumb-loader';

/** A fetch stub whose requests only settle when the test says so, so the
 * in-flight count is observable. */
function deferredFetcher() {
  const pending: Array<{ absPath: string; resolve: (url: string) => void }> = [];
  let live = 0;
  let peak = 0;
  const fetchThumb = vi.fn((absPath: string) => {
    live++;
    peak = Math.max(peak, live);
    return new Promise<string>((resolve) => {
      pending.push({
        absPath,
        resolve: (url) => {
          live--;
          resolve(url);
        },
      });
    });
  });
  return {
    fetchThumb,
    pending,
    peak: () => peak,
    /** Settle every request handed out so far. */
    flush: async () => {
      const batch = pending.splice(0, pending.length);
      for (const p of batch) p.resolve(`blob:${p.absPath}`);
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('TimelineThumbLoader', () => {
  it('never exceeds MAX_CONCURRENT_THUMB_LOADS in flight for a full page', async () => {
    const f = deferredFetcher();
    const loader = new TimelineThumbLoader(f.fetchThumb, () => {});

    for (let i = 0; i < 200; i++) loader.load(`/Lib/p${i}.dng`, '2026-5');
    await Promise.resolve();

    expect(f.peak()).toBe(MAX_CONCURRENT_THUMB_LOADS);
    expect(f.fetchThumb).toHaveBeenCalledTimes(MAX_CONCURRENT_THUMB_LOADS);
  });

  it('drains the whole queue as requests settle', async () => {
    const f = deferredFetcher();
    const loaded: string[] = [];
    const loader = new TimelineThumbLoader(f.fetchThumb, (absPath) => loaded.push(absPath));

    const all = Promise.all(
      Array.from({ length: 10 }, (_, i) => loader.load(`/Lib/p${i}.dng`, '2026-5')),
    );
    for (let round = 0; round < 10; round++) await f.flush();
    await all;

    expect(loaded).toHaveLength(10);
    expect(f.peak()).toBe(MAX_CONCURRENT_THUMB_LOADS);
  });

  it('dedupes a repeat request for a photo already queued or in flight', async () => {
    const f = deferredFetcher();
    const loader = new TimelineThumbLoader(f.fetchThumb, () => {});

    const a = loader.load('/Lib/a.dng', '2026-5');
    const b = loader.load('/Lib/a.dng', '2026-5');
    await f.flush();
    await Promise.all([a, b]);

    expect(f.fetchThumb).toHaveBeenCalledTimes(1);
  });

  it('serves an already-loaded thumb from cache without a second request', async () => {
    const f = deferredFetcher();
    const loader = new TimelineThumbLoader(f.fetchThumb, () => {});

    const first = loader.load('/Lib/a.dng', '2026-5');
    await f.flush();
    await first;
    await loader.load('/Lib/a.dng', '2026-5');

    expect(f.fetchThumb).toHaveBeenCalledTimes(1);
    expect(loader.urls.get('/Lib/a.dng')).toBe('blob:/Lib/a.dng');
  });

  it('drops queued work for a month that scrolled out of view', async () => {
    const f = deferredFetcher();
    const loader = new TimelineThumbLoader(f.fetchThumb, () => {});

    // Saturate the gate with May, then queue June behind it.
    for (let i = 0; i < 20; i++) loader.load(`/Lib/may${i}.dng`, '2026-5');
    for (let i = 0; i < 20; i++) loader.load(`/Lib/jun${i}.dng`, '2026-6');
    await Promise.resolve();

    loader.dropMonth('2026-5');
    for (let round = 0; round < 20; round++) await f.flush();

    const requested = f.fetchThumb.mock.calls.map(([absPath]) => absPath as string);
    // The 4 May thumbs that had already started still complete — only
    // not-yet-started work is dropped.
    expect(requested.filter((p) => p.includes('may'))).toHaveLength(MAX_CONCURRENT_THUMB_LOADS);
    expect(requested.filter((p) => p.includes('jun'))).toHaveLength(20);
  });

  it('abandons all queued work on a scope reset', async () => {
    const f = deferredFetcher();
    const loader = new TimelineThumbLoader(f.fetchThumb, () => {});

    for (let i = 0; i < 50; i++) loader.load(`/Lib/p${i}.dng`, '2026-5');
    await Promise.resolve();
    loader.abandonQueued();
    for (let round = 0; round < 20; round++) await f.flush();

    expect(f.fetchThumb).toHaveBeenCalledTimes(MAX_CONCURRENT_THUMB_LOADS);
  });

  it('retries a failed thumb on a later request instead of caching the failure', async () => {
    const fetchThumb = vi
      .fn<(absPath: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce('blob:ok');
    const loader = new TimelineThumbLoader(fetchThumb, () => {});

    await loader.load('/Lib/a.dng', '2026-5');
    expect(loader.urls.has('/Lib/a.dng')).toBe(false);

    await loader.load('/Lib/a.dng', '2026-5');
    expect(fetchThumb).toHaveBeenCalledTimes(2);
    expect(loader.urls.get('/Lib/a.dng')).toBe('blob:ok');
  });
});
