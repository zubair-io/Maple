import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuidedGeometryRequest } from './raw-pipeline.guided-geometry';
import { handleGuidedGeometry } from './raw-pipeline.guided-geometry-handler';
import * as rawWasm from './pkg/raw_wasm';

vi.mock('./pkg/raw_wasm', () => ({
  solve_guided_geometry: vi.fn(),
}));

describe('handleGuidedGeometry initialization contract (#3974)', () => {
  const postMessage = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('self', { postMessage });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const request: GuidedGeometryRequest = {
    id: 42,
    type: 'guided-geometry',
    points: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    family: 'dslr',
    aspect: 1.5,
    xmp: '<xmp/>',
  };

  it('accepts void-returning initializer and posts success', async () => {
    vi.mocked(rawWasm.solve_guided_geometry).mockReturnValue(
      new Float32Array([12.5, -4.0, 1.25, 0]),
    );
    const ensureReadyVoid = vi.fn(async (): Promise<void> => {});

    await handleGuidedGeometry(request, ensureReadyVoid);

    expect(ensureReadyVoid).toHaveBeenCalledOnce();
    expect(rawWasm.solve_guided_geometry).toHaveBeenCalledWith(
      expect.any(Float32Array),
      'dslr',
      1.5,
      '<xmp/>',
    );
    expect(postMessage).toHaveBeenCalledWith({
      id: 42,
      type: 'guided-geometry-success',
      correction: {
        perspectiveVertical: 12.5,
        perspectiveHorizontal: -4.0,
        perspectiveRotate: 1.25,
        limited: false,
      },
    });
  });

  it('accepts value-returning initializer (e.g. RawWasmInitResult) without contract failure (#3974)', async () => {
    vi.mocked(rawWasm.solve_guided_geometry).mockReturnValue(new Float32Array([5.0, 2.5, 0.0, 1]));
    const mockInitResult = { module: {}, memory: {} };
    const ensureReadyResult = vi.fn(async (): Promise<typeof mockInitResult> => mockInitResult);

    await handleGuidedGeometry(request, ensureReadyResult);

    expect(ensureReadyResult).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({
      id: 42,
      type: 'guided-geometry-success',
      correction: {
        perspectiveVertical: 5.0,
        perspectiveHorizontal: 2.5,
        perspectiveRotate: 0.0,
        limited: true,
      },
    });
  });

  it('posts error response if initializer rejects', async () => {
    const ensureReadyReject = vi.fn(async () => {
      throw new Error('WASM initialization failed');
    });

    await handleGuidedGeometry(request, ensureReadyReject);

    expect(postMessage).toHaveBeenCalledWith({
      id: 42,
      type: 'guided-geometry-error',
      message: 'WASM initialization failed',
    });
  });
});
