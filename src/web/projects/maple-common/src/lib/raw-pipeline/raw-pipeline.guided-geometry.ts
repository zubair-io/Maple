import type { RegisterPending } from './raw-pipeline.dispatch-with-mark';

export type GuideFamily = 'vertical' | 'horizontal' | 'both';
export interface GuidedCorrection {
  perspectiveVertical: number;
  perspectiveHorizontal: number;
  perspectiveRotate: number;
  limited: boolean;
}
export interface GuidedGeometryRequest {
  id: number;
  type: 'guided-geometry';
  points: number[];
  family: GuideFamily;
  aspect: number;
  xmp: string;
}
export type GuidedGeometryResponse =
  | { id: number; type: 'guided-geometry-success'; correction: GuidedCorrection }
  | { id: number; type: 'guided-geometry-error'; message: string };

export function dispatchGuidedGeometry(
  worker: Worker,
  id: number,
  register: RegisterPending,
  input: Omit<GuidedGeometryRequest, 'id' | 'type'>,
): Promise<GuidedCorrection> {
  return new Promise((resolve, reject) => {
    register(id, { kind: 'guided-geometry', resolve, reject });
    worker.postMessage({ ...input, id, type: 'guided-geometry' } satisfies GuidedGeometryRequest);
  });
}
