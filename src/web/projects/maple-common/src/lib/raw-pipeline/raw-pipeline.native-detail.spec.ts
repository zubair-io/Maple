import { describe, expect, it, vi } from 'vitest';
import { NativeDetailClient } from './raw-pipeline.native-detail';
import type { PendingHandler } from './raw-pipeline.service-internals';
import type { NativeDetailArgs } from './raw-pipeline.native-detail.types';

function setup() {
  const worker = { postMessage: vi.fn() };
  const pending = new Map<number, PendingHandler>();
  let id = 0;
  const client = new NativeDetailClient(
    () => worker as unknown as Worker,
    () => ++id,
    pending,
  );
  const args: NativeDetailArgs = {
    sourceId: 'one',
    bytes: new Uint8Array([1, 2, 3]),
    ext: 'dng',
    rect: { x: 0, y: 0, width: 1, height: 1 },
    maxLongEdge: 800,
    qualityPreview: true,
  };
  const settle = (error?: Error) => {
    const h = pending.get(id)!;
    pending.delete(id);
    if (error) h.reject(error);
    else if (h.kind === 'native-detail') h.resolve({ width: 1, height: 1, rgb: new Uint8Array(3) });
  };
  return { client, worker, args, settle, pending };
}

describe('retained native-detail client', () => {
  it('transfers a copy once and retains originals across pan requests', async () => {
    const s = setup();
    let promise = s.client.render(s.args, s.client.revision());
    const request = s.worker.postMessage.mock.calls[0][0];
    expect(new Uint8Array(request.bytes)).toEqual(s.args.bytes);
    expect(request.bytes).not.toBe(s.args.bytes.buffer);
    s.settle();
    await promise;
    promise = s.client.render(s.args, s.client.revision());
    expect(s.worker.postMessage.mock.calls[1][0].bytes).toBeUndefined();
    s.settle();
    await promise;
    s.client.close();
    expect(s.worker.postMessage.mock.lastCall?.[0].type).toBe('close-native-detail');
  });

  it('closes a possibly retained handle even after a failed tile and invalidates queued work', async () => {
    const s = setup();
    const revision = s.client.revision();
    const promise = s.client.render(s.args, revision);
    s.settle(new Error('unsupported stage'));
    await expect(promise).rejects.toThrow('unsupported');
    s.client.close();
    expect(s.worker.postMessage.mock.lastCall?.[0].type).toBe('close-native-detail');
    await expect(s.client.render(s.args, revision)).rejects.toThrow('superseded');
  });

  it('resends RAW after a worker crash and leaves no pending entry after postMessage failure', async () => {
    const s = setup();
    let promise = s.client.render(s.args, s.client.revision());
    s.settle();
    await promise;
    s.client.workerFailed();
    s.worker.postMessage.mockImplementationOnce(() => {
      throw new Error('closed worker');
    });
    await expect(s.client.render(s.args, s.client.revision())).rejects.toThrow('closed worker');
    expect(s.pending.size).toBe(0);
    promise = s.client.render(s.args, s.client.revision());
    expect(s.worker.postMessage.mock.lastCall?.[0].bytes).toBeInstanceOf(ArrayBuffer);
    s.settle();
    await promise;
  });
});
