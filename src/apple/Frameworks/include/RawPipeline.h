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
 * Render a RAW+XMP to an sRGB 8-bit RGB buffer. Returns 0 on success, non-zero
 * on error (call `maple_last_error` for a description). `xmp_path` may be null,
 * in which case AdjustmentModel::default() is used.
 *
 * `quality_preview` selects the internal demosaic / downsample strategy:
 *   0 → `RenderQuality::Full`    (bilinear or HA demosaic, full resolution;
 *                                  export path, matches the parity harness)
 *   1 → `RenderQuality::Preview` (half-res quad demosaic, 4× fewer pixels
 *                                  downstream; use for interactive fast-phase
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
 * demosaic for the fast interactive path, 0 = full export quality.
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
 * Returns the most recent error message for the current thread, or null.
 * The returned pointer remains valid until the next FFI call on this thread.
 */
const char *maple_last_error(void);
