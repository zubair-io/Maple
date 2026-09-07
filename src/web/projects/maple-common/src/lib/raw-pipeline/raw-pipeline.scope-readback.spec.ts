import { describe, expect, it, vi } from 'vitest';
import { SessionScopeReadback } from './raw-pipeline.scope-readback';
import type { WebScopePixels } from './raw-pipeline.scope-colors';

function pendingSample() {
  let resolve!: (pixels: WebScopePixels) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WebScopePixels>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function pixels(value: number): WebScopePixels {
  return { width: 1, height: 1, rgba: new Uint8Array([value, 20, 30, 255]), free: vi.fn() };
}

function setup() {
  const jobs: (() => void)[] = [];
  const publish = vi.fn();
  const captures = [pendingSample(), pendingSample(), pendingSample()];
  let index = 0;
  const session = { colorSpace: 'srgb', sample_scope: vi.fn(() => captures[index++].promise) };
  const readback = new SessionScopeReadback((job) => jobs.push(job), publish);
  const run = () => {
    const job = jobs.shift();
    expect(job).toBeDefined();
    job!();
  };
  return { jobs, publish, captures, session, readback, run };
}

describe('asynchronous session scope capture', () => {
  it('finishes a cold-open sample without needing an edit', async () => {
    const h = setup();
    h.readback.open(10, h.session);
    h.run();
    expect(h.publish).not.toHaveBeenCalled();
    const sample = pixels(40);
    h.captures[0].resolve(sample);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 10, renderId: 10 }),
    );
    expect(new Uint8Array(h.publish.mock.calls[0][0].scope.rgb)).toEqual(
      new Uint8Array([40, 20, 30]),
    );
    expect(sample.free).toHaveBeenCalledOnce();
    expect(h.jobs).toHaveLength(0);
  });

  it('releases the render queue and coalesces a burst into one trailing final capture', async () => {
    const h = setup();
    h.readback.open(10, h.session);
    h.run();
    // A map remains unresolved while each render completes its serialized op.
    for (let id = 11; id <= 50; id++) h.readback.presented(id);
    expect(h.session.sample_scope).toHaveBeenCalledOnce();
    expect(h.jobs).toHaveLength(0);
    const stale = pixels(1);
    h.captures[0].resolve(stale);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(stale.free).toHaveBeenCalledOnce();
    // Keep the most recently completed scopes visible while newer work maps.
    expect(h.publish.mock.calls[0][0].renderId).toBe(10);
    expect(h.jobs).toHaveLength(1);
    h.run();
    h.captures[1].resolve(pixels(90));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.publish.mock.calls[1][0].renderId).toBe(50);
    expect(h.session.sample_scope).toHaveBeenCalledTimes(2);
  });

  it('cancels queued captures and frees pending results across close and replacement', async () => {
    const h = setup();
    h.readback.open(1, h.session);
    h.run();
    h.readback.close();
    h.readback.open(2, h.session);
    const old = pixels(1);
    h.captures[0].resolve(old);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(old.free).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
    h.readback.close();
    h.run();
    expect(h.session.sample_scope).toHaveBeenCalledOnce();
  });

  it('retries a missing presented frame after the next successful edit without looping', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const h = setup();
      h.readback.open(1, h.session);
      h.run();
      h.captures[0].reject(new Error('scope sample: no presented frame'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.jobs).toHaveLength(0);
      h.readback.presented(2);
      h.run();
      h.captures[1].resolve(pixels(2));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.publish.mock.calls[0][0].renderId).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('captures the newest successful presentation when it arrives before the queued job', async () => {
    const h = setup();
    h.readback.open(1, h.session);
    h.readback.presented(2);
    h.readback.presented(3);
    expect(h.jobs).toHaveLength(1);
    h.run();
    h.captures[0].resolve(pixels(3));
    await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
    expect(h.publish.mock.calls[0][0].renderId).toBe(3);
    expect(h.session.sample_scope).toHaveBeenCalledOnce();
  });

  it('does not borrow the session again while an independently completing map publishes', async () => {
    const h = setup();
    h.readback.open(1, h.session);
    h.run();
    Object.defineProperty(h.session, 'colorSpace', {
      get: () => {
        throw new Error('mutable render borrow');
      },
    });
    h.captures[0].resolve(pixels(1));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.publish).toHaveBeenCalledOnce();
  });
});
