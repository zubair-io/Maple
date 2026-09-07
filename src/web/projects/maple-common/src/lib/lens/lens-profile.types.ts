export interface LensProfileSample {
  index: number;
  weight: number;
  focalMm: number;
  apertureApex: number;
  focusM: number;
}

export interface LensProfileResolution {
  reference?: string;
  enabled?: boolean;
  source: 'embedded' | 'lcp';
  confidence: 'embedded' | 'in-range' | 'approximate';
  approximations: string[];
  unsupported: string[];
  distortion?: LensProfileSample[];
  ca?: LensProfileSample[];
  vignetting?: LensProfileSample[];
}

export interface ImportedLensProfile {
  reference: string;
  name: string | null;
  camera: string | null;
  lens: string | null;
  resolution: LensProfileResolution;
}

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
/** May reject any render request whose selected profile cannot be restored. */
export interface LensProfileError {
  id: number;
  type: 'lens-profile-error';
  message: string;
}

/** Worker cache miss; the host supplies authenticated server I/O when available. */
export interface LensProfileFetch {
  id: number;
  type: 'lens-profile-fetch';
  reference: string;
}
export interface LensProfileRestored {
  id: number;
  type: 'lens-profile-restored';
}
