/// <reference lib="webworker" />
import { solve_guided_geometry } from './pkg/raw_wasm';
import type { GuidedGeometryRequest, GuidedGeometryResponse } from './raw-pipeline.guided-geometry';

export async function handleGuidedGeometry(
  req: GuidedGeometryRequest,
  ensureReady: () => Promise<void>,
): Promise<void> {
  try {
    await ensureReady();
    const values = solve_guided_geometry(
      new Float32Array(req.points),
      req.family,
      req.aspect,
      req.xmp,
    );
    const response: GuidedGeometryResponse = {
      id: req.id,
      type: 'guided-geometry-success',
      correction: {
        perspectiveVertical: values[0],
        perspectiveHorizontal: values[1],
        perspectiveRotate: values[2],
        limited: values[3] !== 0,
      },
    };
    self.postMessage(response);
  } catch (error) {
    self.postMessage({
      id: req.id,
      type: 'guided-geometry-error',
      message: error instanceof Error ? error.message : String(error),
    } satisfies GuidedGeometryResponse);
  }
}
