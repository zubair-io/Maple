import type { DecodeSuccess } from './raw-pipeline.types';
import type { MapleRender } from './pkg/raw_wasm';
// Concrete retained-RAW authoring requests (#3934 / #3955). Inference stays
// in its dedicated worker; these operations never run on slider ticks.
export interface RemovalInput {
  sourceId: string;
  bytes: Uint8Array;
  ext: string;
}

export type RemovalAuthoringCommand =
  | {
      kind: 'derivative';
      bytes: ArrayBuffer;
      xmp: string;
      manifest: string;
      companions: ArrayBuffer;
      cap: number;
      film?: ArrayBuffer;
    }
  | { kind: 'source'; bytes: ArrayBuffer }
  | { kind: 'proxy'; xmp: string }
  | { kind: 'map'; xmp: string; request: string }
  | { kind: 'context'; rect: readonly [number, number, number, number] }
  | {
      kind: 'generation-context';
      xmp: string;
      rect: readonly [number, number, number, number];
      manifest: string;
      companions: ArrayBuffer;
    }
  | { kind: 'render-saved'; xmp: string; cap: number; film?: ArrayBuffer }
  | { kind: 'selection'; request: string }
  | { kind: 'refine-selection'; request: string; base: ArrayBuffer; protection: ArrayBuffer }
  | { kind: 'prepare-saved'; xmp: string; manifest: string; companions: ArrayBuffer };

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
  | { kind: 'rendered'; frame: Omit<DecodeSuccess, 'id' | 'type'> }
  | { kind: 'source'; source: string }
  | { kind: 'proxy'; width: number; height: number; rgb: ArrayBuffer }
  | { kind: 'map'; mapping: string }
  | { kind: 'context'; rgb: ArrayBuffer }
  | { kind: 'selection'; mask: ArrayBuffer }
  | { kind: 'prepared'; review: string };

export type RemovalAuthoringResponse =
  | { id: number; type: 'removal-authoring-success'; value: RemovalAuthoringValue }
  | { id: number; type: 'removal-authoring-error'; message: string };

export interface RemovalRawSession {
  removal_selection_proxy?(xmp: string): {
    width: number;
    height: number;
    take_rgb(): Uint8Array;
    free(): void;
  };
  render_saved_preview?(xmp: string, cap: number, film: Uint8Array): MapleRender;
  removal_calibration_source(): string;
  removal_map_points(xmp: string, request: string): string;
  removal_calibration_context(rect: Uint32Array): Float32Array;
  removal_generation_context(xmp: string, rect: Uint32Array): Float32Array;
  prepare_saved_removals(xmp: string, manifest: string, bytes: Uint8Array): string;
}
