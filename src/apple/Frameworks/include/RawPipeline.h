#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

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
 * Opaque heap-allocated byte buffer — used for FFI returns that hand the
 * caller a length-tagged blob (e.g. an encoded JPEG). Free via
 * `maple_free_byte_buffer`.
 *
 * Layout (16 bytes on 64-bit):
 *   bytes:    *mut u8  (8B)
 *   len:      usize    (8B)
 *
 * Free reconstructs a `Box<[u8]>` from `bytes` + `len` (matches the
 * existing `MapleImageBuffer` free dance), so the underlying allocation
 * must be a `Box<[u8]>`-shaped slice (i.e. `len == capacity`).
 */
typedef struct MapleByteBuffer {
  uint8_t *bytes;
  uintptr_t len;
} MapleByteBuffer;

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
 * C-ABI mirror of the slider subset that the per-tick chain consumes.
 * Kept flat (all f32) so cbindgen / Swift's `@_silgen_name` import
 * produce a layout-compatible struct on both sides.
 *
 * Field order matches the Swift `MapleAdjustmentParams` initialiser at
 * `PipelineRenderer.swift::makeAdjustmentParams` byte-for-byte —
 * changing the order here means changing it there.
 */
typedef struct MapleAdjustmentParams {
  float temperature;
  float tint;
  float exposure;
  float contrast;
  float highlights;
  float shadows;
  float whites;
  float blacks;
  float vibrance;
  float saturation;
  float clarity;
  float texture;
  float nr_luminance;
  float dehaze;
  float decoded_temperature;
  float decoded_tint;
  /**
   * 1 = skip the AgX view transform (non-RAW path: input is already
   * display-encoded). 0 = apply AgX (RAW path).
   */
  uint32_t skip_agx;
} MapleAdjustmentParams;

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
 * Extract an embedded JPEG preview / thumbnail from `raw_path`, downsample
 * to `max_px` on the long edge if necessary, then JPEG-encode the result.
 *
 * Avoids the full decode → pipeline → downsample chain entirely:
 * every modern RAW container (DNG, CR3, ARW, NEF, RAF, ORF, RW2, …) embeds
 * a multi-MP JPEG preview that's exactly what we want for a grid tile.
 * Reading that takes a few MB and milliseconds; running the pipeline takes
 * gigabytes and seconds, and on Bun 1.3.12 the `with_large_stack` worker-
 * thread cleanup races against `bun:ffi` and segfaults on subsequent calls
 * after async I/O. This path stays on the calling thread end-to-end and
 * uses bounded memory (preview JPEG → decoded RGB → resized RGB → re-encoded
 * JPEG; ~tens of MB peak on a 100MP DNG).
 *
 * Strategy: try `preview_image` first (largest embedded), fall back to
 * `thumbnail_image` (smaller embedded). If neither exists, return an error
 * — the caller may decide to fall through to a full pipeline render.
 *
 * Returns 0 on success; sets `out` to a `MapleByteBuffer` the caller must
 * free via `maple_free_byte_buffer`. Non-zero on error.
 *
 * `quality` is JPEG quality in [1, 100]. Spec-pinned default is 82; pass 0
 * to use the default.
 */
int32_t maple_render_thumbnail_jpeg(const char *raw_path,
                                    uint32_t max_px,
                                    uint8_t quality,
                                    struct MapleByteBuffer *out);

/**
 * Free a buffer populated by `maple_render_thumbnail_jpeg`.
 */
void maple_free_byte_buffer(struct MapleByteBuffer *buffer);

/**
 * File-output variant of `maple_render_thumbnail_jpeg`. Rust writes the
 * resulting JPEG directly to `out_path` (atomic via .tmp + rename), so no
 * Rust-allocated memory crosses the FFI boundary as a buffer.
 *
 * Why this exists: Bun 1.3.x's `bun:ffi` `toBuffer(ptr, 0, len)` returns a
 * Node Buffer backed by external memory. When the Buffer becomes unreachable
 * JSC's GC sweep tries to free the underlying ArrayBuffer using its own
 * allocator, but the memory was allocated by Rust's `Box::into_raw` (and
 * already freed by `maple_free_byte_buffer`). The double-free segfaults the
 * process during a future GC cycle, sometimes minutes after the FFI call —
 * a use-after-free that's hard to repro in tests but reliably happens under
 * real browse load.
 *
 * File-output sidesteps the issue: Rust owns its allocations end-to-end and
 * JS just reads the resulting file. The cost is one extra fs read, which is
 * negligible (the route writes-through to the same cache file anyway).
 *
 * Returns 0 on success; non-zero on error (call `maple_last_error`).
 */
int32_t maple_render_thumbnail_jpeg_to_file(const char *raw_path,
                                            const char *out_path,
                                            uint32_t max_px,
                                            uint8_t quality);

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
 *          exceeds the 35 px overlap pad). Caller should fall back to
 *          fit-zoom rendering.
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
 * Run the cheap-stage scene-linear chain over a caller-provided fp16 RGBA
 * buffer. Returns 0 on success, non-zero on error (call `maple_last_error`).
 *
 * `in_ptr` and `out_ptr` MUST point to buffers of size
 * `8 * width * height` bytes (= `4 * width * height` fp16 lanes). The
 * caller owns both buffers; this entry doesn't allocate or free.
 * `out_ptr` may alias `in_ptr` only if the caller is willing to lose the
 * input on error — current implementation copies the result at the end
 * so partial in-place is safe but partial-write semantics are undefined
 * on error. Recommend distinct buffers.
 *
 * `params` must be a valid pointer to a `MapleAdjustmentParams` struct
 * the caller owns for the duration of this call.
 */
int32_t maple_apply_scene_linear_chain(const uint16_t *in_ptr,
                                       uint32_t width,
                                       uint32_t height,
                                       const struct MapleAdjustmentParams *params,
                                       uint16_t *out_ptr);

/**
 * Compute BLAKE3 hex of arbitrary bytes. Output buffer must be at least 64
 * bytes (BLAKE3 is 256-bit → 64 hex chars). No null terminator — the caller
 * knows the length is exactly 64.
 *
 * Returns 0 on success, -1 on null pointers, -2 on zero-length input.
 */
int32_t maple_blake3_hex(const uint8_t *bytes_ptr, uintptr_t bytes_len, uint8_t *out_hex);
