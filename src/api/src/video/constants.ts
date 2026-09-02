/**
 * Bounds for the `video-describe` stage's frame sampler.
 *
 * Single source of truth for `probe.ts`, `frame-select.ts`, `frame-extract.ts`,
 * and `sample-frames.ts` — every number here is a code constant, not an
 * operator setting (#2158 design doc): "Defaults are code constants until
 * hardware measurements justify operator settings." Keeping them in one file
 * means the stage's diagnostics (`video_description_meta`) and its tests
 * agree with the sampler on what each bound actually is.
 */

/** Target frame count the sampler aims to send in the normal-path request. */
export const TARGET_FRAME_COUNT = 6;

/** Hard ceiling on frames sent in any single request, including the
 * degradation ladder's "every other frame" rung. */
export const MAX_FRAME_COUNT = 8;

/** Codec I-frame candidates the probe inspects before deduplication. Bounds
 * the single ffmpeg decode pass regardless of clip length. */
export const MAX_CANDIDATE_FRAMES = 64;

/** Side length of the downscaled RGB thumbnail used only for the
 * frame-difference comparison — never sent to the model. */
export const DIFF_THUMB_SIDE = 64;
/** Bytes per `DIFF_THUMB_SIDE × DIFF_THUMB_SIDE` RGB24 thumbnail. */
export const DIFF_THUMB_BYTES = DIFF_THUMB_SIDE * DIFF_THUMB_SIDE * 3;

/** A candidate survives when its normalized mean per-channel pixel
 * difference (0-1 scale) against the last RETAINED candidate is at or
 * above this. */
export const DIFF_THRESHOLD = 0.12;

/** Longest edge, in pixels, of a frame actually sent to the vision model. */
export const MODEL_FRAME_MAX_DIMENSION = 768;
/** JPEG quality for frames sent to the vision model. */
export const MODEL_FRAME_JPEG_QUALITY = 82;

/** Total encoded-frame byte ceiling for one request. Generous headroom over
 * the expected size of `MAX_FRAME_COUNT` frames at the dimension/quality
 * above — a backstop, not an expected steady state. */
export const MAX_TOTAL_ENCODED_BYTES = 8 * 1024 * 1024;

/** Wall-clock budget for the whole probe pass (duration + candidate
 * timestamps + diff thumbnails) in one ffmpeg invocation. */
export const PROBE_TIMEOUT_MS = 30_000;

/** Wall-clock budget per single-frame extraction (seek + decode one frame
 * for the model). Several of these may run per asset, bounded by
 * `MAX_FRAME_COUNT`. */
export const FRAME_EXTRACT_TIMEOUT_MS = 10_000;
