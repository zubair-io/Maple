import type { RemovalModelId } from '../generated/removal-models.generated';

export type RemovalInferenceStage =
  | 'loading-model'
  | 'encoding'
  | 'refining'
  | 'detecting'
  | 'generating';
export interface RemovalDetection {
  class: number;
  bounds: readonly [number, number, number, number];
  score: number;
}
export interface RemovalProposal {
  request: string;
  mask: Uint8Array;
  patch: Uint8Array;
}
export type RemovalInferenceCommand =
  | { kind: 'init'; runtimeBase: string; rawWasm: string }
  | { kind: 'load'; model: RemovalModelId; file: Blob }
  | { kind: 'generate'; rgb: Float32Array; hole: Float32Array }
  | {
      kind: 'propose';
      request: string;
      prior: string;
      scene: Float32Array;
      intent: Uint8Array;
      protected: Uint8Array;
    }
  | { kind: 'encode'; source: string; request: string; rgb: Float32Array }
  | { kind: 'refine'; source: string; request: string }
  | { kind: 'detect'; rgb: Float32Array; size: readonly [number, number] };
export type RemovalInferenceResult =
  | Float32Array
  | Uint8Array
  | RemovalDetection[]
  | RemovalProposal
  | string
  | null;
export interface RemovalInferenceMessage {
  id: number;
  command: RemovalInferenceCommand;
}
export type RemovalInferenceReply =
  | { id: number; stage: RemovalInferenceStage }
  | { id: number; result: RemovalInferenceResult }
  | { id: number; error: string };
