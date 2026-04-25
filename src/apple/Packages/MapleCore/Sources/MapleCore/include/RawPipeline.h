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
 * Free a buffer populated by `maple_render_*_scene_linear`.
 */
void maple_free_scene_linear_buffer(struct MapleSceneLinearBuffer *buffer);

/**
 * Returns the most recent error message for the current thread, or null.
 * The returned pointer remains valid until the next FFI call on this thread.
 */
const char *maple_last_error(void);
