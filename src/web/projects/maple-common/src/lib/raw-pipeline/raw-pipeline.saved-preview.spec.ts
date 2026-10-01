import { describe, expect, it, vi } from 'vitest';
import { SavedRemovalPreviewClient } from './raw-pipeline.saved-preview';
import type { RemovalAuthoringClient } from './raw-pipeline.removal-client';

function harness() {
  const client = {
    open: vi.fn(async () => '{}'),
    prepareSaved: vi.fn(async () => '[]'),
    renderSaved: vi.fn(async () => ({ width: 1, height: 1, rgb: new Uint8Array(3) })),
    close: vi.fn(),
  };
  let chain: Promise<unknown> = Promise.resolve();
  const preview = new SavedRemovalPreviewClient(
    client as unknown as RemovalAuthoringClient,
    (run) => {
      const next = chain.then(run, run);
      chain = next.catch(() => undefined);
      return next;
    },
  );
  const input = { sourceId: 'photo', bytes: new Uint8Array([1]), ext: 'dng' };
  const load = vi.fn(async () => ({ manifest: '[]', bytes: new Uint8Array() }));
  return { client, preview, input, load };
}

describe('normal saved preview preparation lifetime', () => {
  it('loads and transfers a RAW and its companions once across repeated adjustment and refine renders', async () => {
    const { client, preview, input, load } = harness();
    await Promise.all([
      preview.render(input, '[1]', 'ev0', load, 800),
      preview.render(input, '[1]', 'ev1', load, 1600),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(client.open).toHaveBeenCalledTimes(1);
    expect(client.prepareSaved).toHaveBeenCalledTimes(1);
    expect(client.renderSaved.mock.calls).toEqual([
      ['ev0', 800, undefined],
      ['ev1', 1600, undefined],
    ]);
    await preview.render(input, '[2]', 'next record', load, 800);
    expect(load).toHaveBeenCalledTimes(2);
    await preview.render({ ...input, bytes: input.bytes.slice() }, '[2]', 'reopened', load, 800);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('rejects a queued operation closed before it starts and never publishes a late frame', async () => {
    const { client, preview, input, load } = harness();
    const queued = preview.render(input, '[1]', 'xmp', load, 800);
    preview.close();
    await expect(queued).rejects.toThrow('superseded');
    expect(client.open).not.toHaveBeenCalled();
    let release!: () => void;
    const waiting = vi.fn(
      () =>
        new Promise<{ manifest: string; bytes: Uint8Array<ArrayBuffer> }>((resolve) => {
          release = () => resolve({ manifest: '[]', bytes: new Uint8Array() });
        }),
    );
    const late = preview.render(input, '[1]', 'xmp', waiting, 800);
    await vi.waitFor(() => expect(waiting).toHaveBeenCalled());
    preview.close();
    release();
    await expect(late).rejects.toThrow('superseded');
    expect(client.renderSaved).not.toHaveBeenCalled();
  });
  it('does not retain a failed preparation and allows verified recovery', async () => {
    const { client, preview, input, load } = harness();
    client.prepareSaved.mockRejectedValueOnce(new Error('missing companion'));
    await expect(preview.render(input, '[1]', 'xmp', load, 800)).rejects.toThrow('missing');
    expect(client.renderSaved).not.toHaveBeenCalled();
    await preview.render(input, '[1]', 'xmp', load, 800);
    expect(load).toHaveBeenCalledTimes(2);
    expect(client.renderSaved).toHaveBeenCalledTimes(1);
  });
});
