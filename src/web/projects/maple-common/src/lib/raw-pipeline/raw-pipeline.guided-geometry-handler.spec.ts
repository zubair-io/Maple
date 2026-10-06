import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuidedGeometryRequest } from './raw-pipeline.guided-geometry';
import { handleGuidedGeometry } from './raw-pipeline.guided-geometry-handler';
import type { RawWasmInitResult } from './raw-wasm-init';

describe('handleGuidedGeometry initialization contract (#3974)', () => {
  const postMessage = vi.fn();
  const mockSolve = vi.fn();

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
    family: 'vertical',
    aspect: 1.5,
    xmp: '<xmp/>',
  };

  it('accepts void-returning initializer and posts success', async () => {
    mockSolve.mockReturnValue(new Float32Array([12.5, -4.0, 1.25, 0]));
    const ensureReadyVoid = vi.fn(async (): Promise<void> => {});

    await handleGuidedGeometry(request, ensureReadyVoid, mockSolve);

    expect(ensureReadyVoid).toHaveBeenCalledOnce();
    expect(mockSolve).toHaveBeenCalledWith(expect.any(Float32Array), 'vertical', 1.5, '<xmp/>');
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
    mockSolve.mockReturnValue(new Float32Array([5.0, 2.5, 0.0, 1]));
    const mockInitResult: RawWasmInitResult = { threaded: true, threads: 4 };
    const ensureReadyResult = vi.fn(async (): Promise<RawWasmInitResult> => mockInitResult);

    await handleGuidedGeometry(request, ensureReadyResult, mockSolve);

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

    await handleGuidedGeometry(request, ensureReadyReject, mockSolve);

    expect(postMessage).toHaveBeenCalledWith({
      id: 42,
      type: 'guided-geometry-error',
      message: 'WASM initialization failed',
    });
  });
});
