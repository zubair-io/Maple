// Bundled Lensfun lens-profile dropdown (#3569, Web slice of #3564). Shapes
// for a picker that resolves the current `papp:LensProfile` reference AND
// lists the compatible bundled lenses directly against raw-core's
// `lens_profile` module — the wasm side of Apple's `LensProfileChoice.swift`
// (its `Evidence`/`CompatibleLens` are the structural twins here).
//
// Deliberately its OWN types, separate from `lens-profile.types.ts`'s
// `LensProfileResolution` (#3479): that shape is fed by every RENDER reply
// and its validator (`lens-profile.metadata.ts`) only recognises
// `source: 'embedded' | 'lcp'` — a Lensfun verdict riding along on
// `lens_profile_json` is silently dropped there today, by design, so the
// already-shipped import panel stays unaffected by this ticket. This file's
// evidence is fetched directly (`resolveLensProfile`/`compatibleLensProfiles`,
// independent of any render), and understands the fuller source vocabulary
// raw-core's `Resolution::metadata()` / raw-ffi's own fallback produce:
// `'embedded' | 'lcp' | 'lensfun' | 'none'`.

/** One bundled lens the RAW's camera body can carry (`compatible_lenses`). */
export interface CompatibleLensProfile {
  slug: string;
  maker: string;
  model: string;
}

/**
 * The resolver's verdict for ONE `papp:LensProfile` reference, fetched
 * directly for the picker. Mirrors raw-core's `Resolution::metadata()` plus
 * the `'none'`/`'embedded'` fallback raw-ffi's `maple_lens_profile_resolve_file`
 * already produces (now mirrored in `resolveLensProfile`, #3569) for a
 * reference that resolves to neither an LCP nor a Lensfun match.
 *
 * `lens`/`dbVersion` are present only for a Lensfun match (`null` for `lcp`,
 * absent for `embedded`/`none`).
 */
export interface LensProfileEvidence {
  source: 'embedded' | 'lcp' | 'lensfun' | 'none';
  confidence: 'embedded' | 'in-range' | 'approximate';
  lens?: string | null;
  dbVersion?: string | null;
  hasDistortion: boolean;
  hasCa: boolean;
  hasVignetting: boolean;
  approximations: string[];
  unsupported: string[];
}

/** Main thread → worker: list every bundled lens `bytes`' camera body can carry. */
export interface LensProfileCompatibleRequest {
  id: number;
  type: 'lens-profile-compatible';
  bytes: ArrayBuffer;
  ext: string;
}
export interface LensProfileCompatibleSuccess {
  id: number;
  type: 'lens-profile-compatible-success';
  lenses: CompatibleLensProfile[];
}
export interface LensProfileCompatibleError {
  id: number;
  type: 'lens-profile-compatible-error';
  message: string;
}

/** Main thread → worker: resolve `reference` (`''` = automatic) against `bytes`. */
export interface LensProfileEvidenceRequest {
  id: number;
  type: 'lens-profile-evidence';
  bytes: ArrayBuffer;
  ext: string;
  reference: string;
}
export interface LensProfileEvidenceSuccess {
  id: number;
  type: 'lens-profile-evidence-success';
  evidence: LensProfileEvidence;
}
export interface LensProfileEvidenceError {
  id: number;
  type: 'lens-profile-evidence-error';
  message: string;
}
