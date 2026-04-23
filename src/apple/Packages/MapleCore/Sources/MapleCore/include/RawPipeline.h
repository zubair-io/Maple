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
 */
int32_t maple_render_file(const char *raw_path, const char *xmp_path, struct MapleImageBuffer *out);

/**
 * Free a buffer populated by `maple_render_file`.
 */
void maple_free_buffer(struct MapleImageBuffer *buffer);

/**
 * Returns the most recent error message for the current thread, or null.
 * The returned pointer remains valid until the next FFI call on this thread.
 */
const char *maple_last_error(void);
