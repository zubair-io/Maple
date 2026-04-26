#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

/**
 * Opaque handle wrapping a stitched panorama image and a precomputed
 * f16 RGB pixel cache.
 *
 * # Safety
 * All FFI functions that accept `*const PanoHandle` require that the
 * pointer is non-null and that the pointed-to handle was constructed by
 * `pano_stitch` (or `handle_from_image` in tests).  A null pointer
 * always returns a null/zero result rather than dereferencing.
 */
typedef struct PanoHandle PanoHandle;

typedef struct MapleImageBuffer {
  /**
   * Pointer to heap-allocated RGB u8 buffer. Free via `maple_free_buffer`.
   */
  uint8_t *rgb;
  /**
   * Bytes in the buffer (= 3 * width * height).
   */
  uintptr_t len;
  uint32_t width;
  uint32_t height;
} MapleImageBuffer;

/**
 * Scene-linear FFI buffer — Rec.2020 fp16 RGBA, straight alpha, row-major.
 *
 * `bytes_per_pixel` is always 8 (4 channels × 2 bytes per fp16 lane). It
 * is exposed in the struct so the Apple consumer can read the layout
 * without hard-coding the constant; future plans (e.g. higher bit depth
 * for HDR) can change it without breaking the ABI.
 */
typedef struct MapleSceneLinearBuffer {
  /**
   * Pointer to heap-allocated fp16 RGBA buffer. Free via
   * `maple_free_scene_linear_buffer`.
   */
  uint16_t *fp16_rgba;
  /**
   * Bytes in the buffer (= 4 * 2 * width * height = 8 * width * height).
   */
  uintptr_t len_bytes;
  /**
   * Channels per pixel (always 4: R, G, B, A).
   */
  uint32_t channels;
  /**
   * Bytes per pixel (always 8 for fp16 RGBA).
   */
  uint32_t bytes_per_pixel;
  uint32_t width;
  uint32_t height;
} MapleSceneLinearBuffer;

/**
 * Opaque handle to a decoded RawImage + parsed AdjustmentModel.
 * Allocate via `maple_open_raw_handle` (or
 * `maple_open_raw_handle_bytes`); free via `maple_close_raw_handle`.
 * The pointee layout is intentionally undocumented; callers must treat
 * `*mut MapleRawHandle` as opaque.
 */
typedef struct MapleRawHandle {
  /**
   * Opaque pointer to a heap-allocated `MapleRawHandleInner`. Not
   * introspected by callers.
   */
  void *inner;
} MapleRawHandle;

/**
 * Configuration passed to `pano_stitch`.
 *
 * Fields mirror the C ABI struct so cbindgen/the build-script heredoc
 * emits the right layout:
 *   - `projection`:    0 = Rectilinear, 1 = Cylindrical, 2 = Spherical
 *   - `parallax_mode`: 0 = Homography, 1 = TpsMesh (TPS unimplemented; ignored)
 *   - `max_dimension`: long-edge clamp in pixels, 0 = unconstrained
 */
typedef struct PanoOptions {
  uint32_t projection;
  uint32_t parallax_mode;
  uint32_t max_dimension;
} PanoOptions;

/**
 * Render a RAW+XMP to an sRGB 8-bit RGB buffer. Returns 0 on success, non-zero
 * on error (call `maple_last_error` for a description). `xmp_path` may be null,
 * in which case AdjustmentModel::default() is used.
 *
 * `quality_preview` selects the internal demosaic / downsample strategy:
 *   0 → `RenderQuality::Full`    (bilinear or HA demosaic, full resolution;
 *                                  export path, matches the parity harness)
 *   1 → `RenderQuality::Preview` (half-res quad demosaic; the returned
 *                                  buffer is at half the sensor's dimensions
 *                                  in both axes — caller must scale for
 *                                  display; use for interactive fast-phase
 *                                  so a 100MP RAW decodes in seconds)
 */
int32_t maple_render_file(const char *raw_path,
                          const char *xmp_path,
                          int32_t quality_preview,
                          struct MapleImageBuffer *out);

/**
 * Render a RAW from a byte slice (PhotoKit, self-hosted API, etc.) through
 * the pipeline. Identical to `maple_render_file` except the caller hands us
 * bytes instead of a path, and supplies an extension hint (e.g. "dng", "cr2",
 * "arw") so the decoder can dispatch.
 *
 * `xmp_path` may be null, in which case `AdjustmentModel::default()` is used.
 * `hint_ext` must be a UTF-8 C string naming the RAW extension (without dot).
 * `quality_preview` mirrors `maple_render_file` — 1 = half-res preview
 * demosaic for the fast interactive path (returned buffer is at half the
 * sensor's dimensions in both axes; caller must scale for display),
 * 0 = full export quality.
 */
int32_t maple_render_bytes(const uint8_t *raw_bytes,
                           uintptr_t raw_len,
                           const char *hint_ext,
                           const char *xmp_path,
                           int32_t quality_preview,
                           struct MapleImageBuffer *out);

/**
 * Free a buffer populated by `maple_render_file` or `maple_render_bytes`.
 */
void maple_free_buffer(struct MapleImageBuffer *buffer);

/**
 * Render a RAW+XMP to a scene-linear Rec.2020 fp16 RGBA buffer. Returns
 * 0 on success, non-zero on error (call `maple_last_error`). The output
 * pre-AgX, pre-Rec.2020->sRGB — the caller is expected to apply a view
 * transform and gamut convert before display.
 *
 * `quality_preview` mirrors `maple_render_file` — 1 = half-res preview,
 * 0 = full export.
 */
int32_t maple_render_file_scene_linear(const char *raw_path,
                                       const char *xmp_path,
                                       int32_t quality_preview,
                                       struct MapleSceneLinearBuffer *out);

/**
 * Render a RAW from a byte slice to a scene-linear Rec.2020 fp16 RGBA
 * buffer. Mirrors `maple_render_bytes` for the new path.
 */
int32_t maple_render_bytes_scene_linear(const uint8_t *raw_bytes,
                                        uintptr_t raw_len,
                                        const char *hint_ext,
                                        const char *xmp_path,
                                        int32_t quality_preview,
                                        struct MapleSceneLinearBuffer *out);

/**
 * Sized scene-linear render — same as `maple_render_file_scene_linear`
 * but downsamples to fit within `max_long_edge` on its long edge,
 * preserving aspect ratio, never upscaling. Same return / error
 * conventions and the same `MapleSceneLinearBuffer` output struct.
 *
 * API choice: a single `max_long_edge` u32 instead of `max_width/
 * max_height` simplifies WASM/Web parity (Plan 3 will mirror this on
 * the Web FFI; one scalar keeps the JS binding signature shorter).
 * Aspect math is local to the Rust renderer because it knows the
 * source dimensions.
 *
 * Plan 1 v2 — see docs/superpowers/plans/2026-04-24-ffi-split-plan-1.md
 * Task 8 and docs/tickets/06-viewport-sized-rust-ffi-preview.md
 * Milestone 2.
 */
int32_t maple_render_file_scene_linear_sized(const char *raw_path,
                                             const char *xmp_path,
                                             uint32_t max_long_edge,
                                             int32_t quality_preview,
                                             struct MapleSceneLinearBuffer *out);

/**
 * Sized scene-linear render from a byte slice — bytes equivalent of
 * `maple_render_file_scene_linear_sized`. Same args + `raw_bytes` /
 * `raw_len` / `hint_ext`.
 */
int32_t maple_render_bytes_scene_linear_sized(const uint8_t *raw_bytes,
                                              uintptr_t raw_len,
                                              const char *hint_ext,
                                              const char *xmp_path,
                                              uint32_t max_long_edge,
                                              int32_t quality_preview,
                                              struct MapleSceneLinearBuffer *out);

/**
 * Tile scene-linear render — same fp16 RGBA output struct as the sized
 * variant, but renders only the source-pixel rectangle
 * `(src_x, src_y, src_w, src_h)`. Pads internally by 35 px to satisfy
 * the development chain's stencil radii (clarity is the binding
 * constraint), then trims to the inner rect, downsamples to
 * `(out_w, out_h)`, orients, and packs to fp16 RGBA.
 *
 * Returns 0 on success. Error codes mirror `maple_render_file_scene_linear`
 * plus:
 *   - 9:  `src_w/src_h/out_w/out_h == 0` — bad tile geometry.
 *   - 10: `model.dehaze != 0` — tile path is not supported (radius 67
 *     exceeds the 35 px overlap pad). Caller should fall back to
 *     fit-zoom rendering.
 *   - 11: `out_w > src_w || out_h > src_h` — tile path is downscale-only.
 *
 * Plan 3 — see docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
 * Task 2 and docs/tickets/06-viewport-sized-rust-ffi-preview.md M4.
 */
int32_t maple_render_file_scene_linear_tile(const char *raw_path,
                                            const char *xmp_path,
                                            uint32_t src_x,
                                            uint32_t src_y,
                                            uint32_t src_w,
                                            uint32_t src_h,
                                            uint32_t out_w,
                                            uint32_t out_h,
                                            int32_t quality_preview,
                                            struct MapleSceneLinearBuffer *out);

/**
 * Tile scene-linear render from a byte slice — bytes equivalent of
 * `maple_render_file_scene_linear_tile`. Same arguments + `raw_bytes` /
 * `raw_len` / `hint_ext` (mirroring the bytes-variant convention from
 * `maple_render_bytes_scene_linear_sized`).
 */
int32_t maple_render_bytes_scene_linear_tile(const uint8_t *raw_bytes,
                                             uintptr_t raw_len,
                                             const char *hint_ext,
                                             const char *xmp_path,
                                             uint32_t src_x,
                                             uint32_t src_y,
                                             uint32_t src_w,
                                             uint32_t src_h,
                                             uint32_t out_w,
                                             uint32_t out_h,
                                             int32_t quality_preview,
                                             struct MapleSceneLinearBuffer *out);

/**
 * Free a buffer populated by `maple_render_*_scene_linear`.
 */
void maple_free_scene_linear_buffer(struct MapleSceneLinearBuffer *buffer);

/**
 * Open a RAW + optional XMP sidecar into an opaque handle suitable for
 * repeated tile rendering. The handle owns the rawler-decoded mosaic
 * and the parsed AdjustmentModel; subsequent calls to
 * `maple_render_handle_scene_linear_tile` skip both.
 *
 * `xmp_path` may be null — in that case `AdjustmentModel::default()`
 * is stored in the handle.
 *
 * Returns 0 on success and writes the handle pointer into
 * `*handle_out`. Non-zero on error (call `maple_last_error` for the
 * message). The output handle pointer is always written: it is null
 * on error and non-null on success.
 *
 * The caller must eventually free the handle via
 * `maple_close_raw_handle`. Failing to do so leaks the underlying
 * `RawImage` (~30-300 MB depending on sensor resolution).
 */
int32_t maple_open_raw_handle(const char *raw_path,
                              const char *xmp_path,
                              struct MapleRawHandle **handle_out);

/**
 * Bytes-variant of `maple_open_raw_handle`. Decodes from an in-memory
 * RAW byte slice (PhotoKit / network-source codepaths). `hint_ext` is
 * the extension without the leading dot (e.g. `"dng"`); pass null or
 * empty for content-sniff fallback.
 */
int32_t maple_open_raw_handle_bytes(const uint8_t *raw_bytes,
                                    uintptr_t raw_len,
                                    const char *hint_ext,
                                    const char *xmp_path,
                                    struct MapleRawHandle **handle_out);

/**
 * Render a tile from a previously opened raw handle. Same arguments
 * and error codes as `maple_render_file_scene_linear_tile` minus the
 * path / xmp handling — the handle already carries the decoded
 * `RawImage` and parsed `AdjustmentModel`.
 *
 * Error codes:
 *   - 1: null pointer argument
 *   - 9: bad tile geometry (src_w/src_h/out_w/out_h == 0)
 *   - 10: dehaze active in the handle's model — tile path unsafe
 *   - 11: upscale attempt (out > src) — tile path is downscale-only
 *   - 8: any other error from the core tile renderer
 */
int32_t maple_render_handle_scene_linear_tile(const struct MapleRawHandle *handle,
                                              uint32_t src_x,
                                              uint32_t src_y,
                                              uint32_t src_w,
                                              uint32_t src_h,
                                              uint32_t out_w,
                                              uint32_t out_h,
                                              int32_t quality_preview,
                                              struct MapleSceneLinearBuffer *out);

/**
 * Free a `MapleRawHandle` and its inner `RawImage` + `AdjustmentModel`.
 * No-op when `handle` is null. Apple's `MapleRawHandleBox.deinit` calls
 * this on cache eviction or asset switch.
 */
void maple_close_raw_handle(struct MapleRawHandle *handle);

/**
 * Returns the most recent error message for the current thread, or null.
 * The returned pointer remains valid until the next FFI call on this thread.
 */
const char *maple_last_error(void);

/**
 * Stitch `n_inputs` RAW/PNG/JPEG byte slices into a panorama.
 *
 * # Arguments
 * * `inputs`      — array of `n_inputs` pointers, each to a byte slice.
 * * `input_lens`  — array of `n_inputs` byte-slice lengths.
 * * `n_inputs`    — number of inputs (must be ≥ 2).
 * * `dcps` — parallel array of DCP byte-slice pointers (may be null
 *   entries); accepted in the ABI but currently ignored —
 *   rawler reads embedded DCPs from the DNG container.
 * * `dcp_lens` — lengths of the DCP slices (ignored alongside `dcps`).
 * * `options`     — stitch options struct; may be null (defaults applied).
 * * `out_handle`  — on success, receives a heap-allocated `*mut PanoHandle`.
 *
 * # Return value
 *   0  success; `*out_handle` is non-null and caller-owned.
 *  -1  invalid arguments (null inputs/out_handle, n_inputs < 2, null
 *      element pointer).
 *  -2  decode failure for one of the inputs.
 *  -3  stitch pipeline failure (ORB / match / BA / warp / blend error).
 *
 * # Safety
 * All input pointers must be valid for `n_inputs` reads.  `out_handle` must
 * be non-null.  On success the caller owns the handle and must eventually
 * call `pano_free`.
 */
int32_t pano_stitch(const uint8_t *const *inputs,
                    const uintptr_t *input_lens,
                    uintptr_t n_inputs,
                    const uint8_t *const *_dcps,
                    const uintptr_t *_dcp_lens,
                    const struct PanoOptions *_options,
                    struct PanoHandle **out_handle);

/**
 * Return the panorama width in pixels.
 *
 * Returns 0 if `handle` is null.
 *
 * # Safety
 * `handle` must be a non-null pointer to a live `PanoHandle`.
 */
uint32_t pano_get_width(const struct PanoHandle *handle);

/**
 * Return the panorama height in pixels.
 *
 * Returns 0 if `handle` is null.
 *
 * # Safety
 * `handle` must be a non-null pointer to a live `PanoHandle`.
 */
uint32_t pano_get_height(const struct PanoHandle *handle);

/**
 * Return the number of f16 elements in the pixel buffer
 * (`width * height * 3`; **elements**, not bytes).
 *
 * Returns 0 if `handle` is null.
 *
 * # Safety
 * `handle` must be a non-null pointer to a live `PanoHandle`.
 */
uintptr_t pano_get_pixels_len(const struct PanoHandle *handle);

/**
 * Return a pointer to the f16 (half-precision, stored as `u16`) RGB
 * pixel buffer owned by `handle`.
 *
 * The buffer is interleaved RGB f16, row-major, with
 * `pano_get_pixels_len(handle)` elements.  The pointer is valid for
 * the lifetime of the handle.
 *
 * Returns null if `handle` is null or the buffer is empty.
 *
 * # Safety
 * `handle` must be a non-null pointer to a live `PanoHandle`.
 */
const uint16_t *pano_get_pixels_f16(const struct PanoHandle *handle);

/**
 * Return a pointer to the f32 RGB pixel data owned by `handle`.
 *
 * The pixel buffer is interleaved RGB f32, row-major, with
 * `handle.image.width * handle.image.height * 3` elements.
 * The pointer is valid for the lifetime of the handle.
 * Returns null if `handle` is null.
 *
 * # Safety
 * `handle` must be a non-null pointer to a live `PanoHandle`.
 */
const float *pano_get_pixels_f32(const struct PanoHandle *handle);

/**
 * Free a `PanoHandle` allocated by `pano_stitch`.
 *
 * No-op when `handle` is null.
 *
 * # Safety
 * `handle` must be null or a pointer returned by `pano_stitch` that has
 * not already been freed.
 */
void pano_free(struct PanoHandle *handle);
