// ── Auto-adjust one-shot (#1379) ─────────────────────────────────────────────
// Standalone decode + probe: the worker calls `compute_auto_adjustments_from_bytes`
// with the RAW bytes and (optionally) the current XMP, returning the 8-field
// recommended slider patch. The caller MUST apply `autoExposure: 'Off'` alongside
// `exposure` (the returned value is measured against an AE-Off probe). The
// Angular consumer applies `{ exposure, contrast, highlights, shadows, whites,
// blacks, autoExposure: 'Off' }` — the calibrated tone sliders (#1376/#2255).
// `temperature`/`tint` are returned too but intentionally NOT applied — white
// balance stays at As-Shot (see `EditorStateService.applyAuto`).

/** Request the worker to analyse a RAW and return auto adjustment recommendations (#1379). */
export interface AutoAdjustRequest {
  id: number;
  type: 'auto-adjust';
  /** Transferable RAW bytes — consumed by the worker; do NOT re-use after posting. */
  bytes: ArrayBuffer;
  /** Lowercase file extension, e.g. `"dng"`. */
  ext: string;
  /** Optional current XMP sidecar text (passed to the WASM; `undefined` = fresh open). */
  xmp?: string;
}

/**
 * The 8-field recommendation returned by the WASM `compute_auto_adjustments_from_bytes`.
 * `exposure` is in EV; `temperature` is in Kelvin; `tint` and the five tone fields are in
 * ±100 units. The five tone fields are calibrated, scene-proportional values (#1376) —
 * the Angular consumer applies them alongside `exposure`; see `EditorStateService.applyAuto`.
 */
export interface AutoAdjustPatch {
  exposure: number;
  temperature: number;
  tint: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

/** Worker → main thread: auto-adjust computation succeeded. */
export interface AutoAdjustSuccess {
  id: number;
  type: 'auto-adjust-success';
  patch: AutoAdjustPatch;
}

/** Worker → main thread: auto-adjust computation failed. */
export interface AutoAdjustError {
  id: number;
  type: 'auto-adjust-error';
  message: string;
}
