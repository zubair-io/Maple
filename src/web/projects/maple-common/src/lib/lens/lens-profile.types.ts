// Imported LCP lens profiles on the Web (#3479, slice 3 of #3395).
//
// The shapes shared between the render worker (`raw-pipeline.lens-profile.ts`),
// the main-thread pipeline service and the Lens Corrections panel. Every
// JSON document here is produced by raw-core (`lens_profile::register` /
// `Resolution::metadata`) and validated once, on the worker side, by
// `lens-profile.metadata.ts` before it reaches any signal.

/** One calibration record the resolver interpolated, with its weight. */
export interface LensProfileSample {
  index: number;
  weight: number;
  focalMm: number;
  apertureApex: number;
  focusM: number;
}

/**
 * The resolver's verdict for one RAW + profile pair. `embedded` means the
 * RAW carries its own `OpcodeList3`, which raw-core always prefers — the
 * imported profile is inert for that image. `lcp` carries the per-family
 * calibration presence (a family the calibration lacks stays inert and its
 * strength slider disables) plus the selected samples, the approximations
 * that need explicit acknowledgement, and the records the parser could not
 * support. A decode-time resolution also names the sidecar `reference` it
 * was made for and whether the model had corrections `enabled`.
 */
export interface LensProfileResolution {
  reference?: string;
  enabled?: boolean;
  source: 'embedded' | 'lcp';
  confidence: 'embedded' | 'in-range' | 'approximate';
  approximations: string[];
  unsupported: string[];
  hasDistortion?: boolean;
  hasCa?: boolean;
  hasVignetting?: boolean;
  distortion?: LensProfileSample[];
  ca?: LensProfileSample[];
  vignetting?: LensProfileSample[];
}

/** The inventory raw-core reports for a registered document. */
export interface LensProfileInventory {
  /** `lcp1:<BLAKE3>` of the exact imported bytes. */
  reference: string;
  name: string | null;
  make: string | null;
  camera: string | null;
  lens: string | null;
  sampleCount: number;
}

/** An import the worker registered, persisted and resolved for one RAW. */
export interface ImportedLensProfile extends LensProfileInventory {
  resolution: LensProfileResolution;
}

/** Main thread → worker: register `xml`, persist it, resolve it for the RAW. */
export interface LensProfileRequest {
  id: number;
  type: 'import-lens-profile';
  xml: string;
  bytes: ArrayBuffer;
  ext: string;
}
export interface LensProfileSuccess {
  id: number;
  type: 'lens-profile-success';
  profile: ImportedLensProfile;
}
/** The import failed: unparsable document, camera/lens mismatch, unsupported model, persistence. */
export interface LensProfileError {
  id: number;
  type: 'lens-profile-error';
  message: string;
}

/**
 * Worker → main thread: a render named a profile the worker's IndexedDB copy
 * cannot supply. Self Hosted answers by restoring it from the server cache
 * into IndexedDB; Hosted has nowhere else to look. Either way the reply is
 * `lens-profile-restored`, after which the worker re-reads IndexedDB.
 */
export interface LensProfileFetch {
  id: number;
  type: 'lens-profile-fetch';
  reference: string;
}
export interface LensProfileRestored {
  id: number;
  type: 'lens-profile-restored';
}

/**
 * Broadcast (id 0) whenever the worker learns whether the profile a render
 * named can be supplied. `available: false` is what the panel shows as an
 * explicit error: raw-core refuses to render a required profile it does not
 * hold, so the alternative would be a silently uncorrected image.
 */
export interface LensProfileStatus {
  id: 0;
  type: 'lens-profile-status';
  reference: string;
  available: boolean;
  message?: string;
}
