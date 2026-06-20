// raw-pipeline.service-internals.ts
// Extracted from raw-pipeline.service.ts (pure code move — no behaviour change).
// Contains: public session result types (OpenedLiveSession, RenderedLiveSession)
// and the pending-handler discriminated union used by RawPipelineService.

import type { AutoAdjustPatch, DecodedImage, DecodedSceneLinearImage } from './raw-pipeline.types';

/**
 * Result of opening a persistent GPU live session (epic #925, P4b-web / #1038):
 * the developed image dims (== the transferred canvas dims — viewport-sized per
 * #1080, ≤ the requested `maxLongEdge` on the long edge, aspect preserved), the
 * NATIVE oriented dims (for the asset record + zoom math, #1101 contract), the
 * camera As-Shot WB (for seeding the sliders, like the `decode()` path), and the
 * achieved canvas colour-space tag the browser configured.
 */
export interface OpenedLiveSession {
  width: number;
  height: number;
  /**
   * Native oriented dims — see `OpenSessionSuccess.nativeWidth` (#1080).
   * Optional for back-compat with stubs/producers that never size down
   * (mirrors `DecodedImage.nativeWidth`) — absent means `width`/`height` ARE
   * native.
   */
  nativeWidth?: number;
  nativeHeight?: number;
  asShotTemperature: number;
  asShotTint: number;
  colorSpace: string;
  /**
   * Downsampled RGB readback of the first presented frame, for the scopes (#1045).
   * Packed into the `DecodedImage` shape so it drops straight into `currentPixels`.
   * `undefined` when the worker couldn't snapshot the surface → scopes keep their
   * pseudo fallback (no regression vs today's flag-on path).
   */
  scopePixels?: DecodedImage;
}

/**
 * Result of re-rendering a live session for an edit (#846): the achieved canvas
 * colour-space tag plus an optional downsampled readback for the scopes (#1045).
 */
export interface RenderedLiveSession {
  colorSpace: string;
  scopePixels?: DecodedImage;
}

/** Discriminated union of all pending worker-request handler entries. */
export type PendingHandler =
  | {
      kind: 'legacy';
      resolve: (img: DecodedImage) => void;
      reject: (err: Error) => void;
    }
  | {
      kind: 'scene-linear';
      resolve: (img: DecodedSceneLinearImage) => void;
      reject: (err: Error) => void;
    }
  | {
      kind: 'open-session';
      resolve: (info: OpenedLiveSession) => void;
      reject: (err: Error) => void;
    }
  | {
      kind: 'render-session';
      resolve: (result: RenderedLiveSession) => void;
      reject: (err: Error) => void;
    }
  | {
      kind: 'auto-adjust';
      resolve: (patch: AutoAdjustPatch) => void;
      reject: (err: Error) => void;
    };
