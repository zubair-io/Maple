import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeWebGpuPresent } from './image-canvas.present-probes';

function setupProbe(
  options: {
    black?: boolean;
    readbackError?: boolean;
    queueError?: boolean;
    missingContext?: boolean;
  } = {},
) {
  const destroy = vi.fn();
  const drawImage = vi.fn();
  const getImageData = vi.fn(() => {
    if (options.readbackError) throw new Error('readback rejected');
    return { data: new Uint8ClampedArray(options.black ? [0, 0, 0, 0] : [128, 191, 255, 255]) };
  });
  const configure = vi.fn();
  const submit = vi.fn();
  const onSubmittedWorkDone = vi.fn(async () => {
    if (options.queueError) throw new Error('submitted work rejected');
  });
  const device = {
    destroy,
    queue: { submit, onSubmittedWorkDone },
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ end: vi.fn() }),
      finish: () => ({}),
    }),
  };
  const requestDevice = vi.fn(async () => device);
  vi.stubGlobal('navigator', {
    gpu: {
      requestAdapter: async () => ({ requestDevice }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext(kind: string) {
        if (kind === 'webgpu')
          return options.missingContext
            ? null
            : {
                configure,
                getCurrentTexture: () => ({ createView: () => ({}) }),
              };
        if (kind === '2d') return { drawImage, getImageData };
        return null;
      }
    },
  );
  return { destroy, drawImage, getImageData, configure, submit, onSubmittedWorkDone, device };
}

afterEach(() => vi.unstubAllGlobals());

describe('actual WebGPU composition probe lifecycle', () => {
  it('accepts a presented pixel and destroys its temporary device', async () => {
    const probe = setupProbe();
    expect(await probeWebGpuPresent()).toBe(true);
    expect(probe.configure).toHaveBeenCalledWith({
      device: probe.device,
      format: 'bgra8unorm',
      usage: 17,
    });
    expect(probe.submit).toHaveBeenCalledTimes(1);
    expect(probe.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    expect(probe.drawImage).toHaveBeenCalledTimes(1);
    expect(probe.destroy).toHaveBeenCalledTimes(1);
  });

  it('rejects a black readback and destroys its device', async () => {
    const probe = setupProbe({ black: true });
    expect(await probeWebGpuPresent()).toBe(false);
    expect(probe.getImageData).toHaveBeenCalledTimes(1);
    expect(probe.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys an acquired device when readback throws', async () => {
    const probe = setupProbe({ readbackError: true });
    expect(await probeWebGpuPresent()).toBe(false);
    expect(probe.onSubmittedWorkDone).toHaveBeenCalledTimes(1);
    expect(probe.getImageData).toHaveBeenCalledTimes(1);
    expect(probe.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys an acquired device when submitted work rejects, without reading back', async () => {
    const probe = setupProbe({ queueError: true });
    expect(await probeWebGpuPresent()).toBe(false);
    expect(probe.submit).toHaveBeenCalledTimes(1);
    expect(probe.drawImage).not.toHaveBeenCalled();
    expect(probe.destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys an acquired device when no WebGPU canvas context is available', async () => {
    const probe = setupProbe({ missingContext: true });
    expect(await probeWebGpuPresent()).toBe(false);
    expect(probe.submit).not.toHaveBeenCalled();
    expect(probe.destroy).toHaveBeenCalledTimes(1);
  });
});
