// Concrete retained-RAW authoring requests (#3934 / #3955). Inference stays
// in its dedicated worker; these operations never run on slider ticks.
export interface RemovalInput {
  sourceId: string;
  bytes: Uint8Array;
  ext: string;
}

export type RemovalAuthoringCommand =
  | { kind: 'source'; bytes: ArrayBuffer }
  | { kind: 'map'; xmp: string; request: string }
  | { kind: 'context'; rect: readonly [number, number, number, number] }
  | { kind: 'selection'; request: string };

export interface RemovalAuthoringRequest {
  id: number;
  type: 'removal-authoring';
  sourceId: string;
  ext: string;
  /** Required after source preparation: reject an old or different mosaic. */
  original?: string;
  command: RemovalAuthoringCommand;
}

export type RemovalAuthoringValue =
  | { kind: 'source'; source: string }
  | { kind: 'map'; mapping: string }
  | { kind: 'context'; rgb: ArrayBuffer }
  | { kind: 'selection'; mask: ArrayBuffer };

export type RemovalAuthoringResponse =
  | { id: number; type: 'removal-authoring-success'; value: RemovalAuthoringValue }
  | { id: number; type: 'removal-authoring-error'; message: string };

export interface RemovalRawSession {
  removal_calibration_source(): string;
  removal_map_points(xmp: string, request: string): string;
  removal_calibration_context(rect: Uint32Array): Float32Array;
}
