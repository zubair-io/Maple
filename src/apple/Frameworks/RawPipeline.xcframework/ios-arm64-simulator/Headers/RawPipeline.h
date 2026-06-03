#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

/**
 * FFI return type for [`maple_compute_auto_tone`]. Plain C struct so the
 * Apple Swift binding (`MapleCore`) and any other native consumer can
 * mirror it 1:1 — slider rest position is encoded as the literal `0.0`,
 * no `Option` plumbing required.
 */
typedef struct MapleAutoTone {
  float exposure;
  float contrast;
  float whites;
  float blacks;
  float highlights;
  float shadows;
} MapleAutoTone;

/**
 * Output buffer for the legacy 8-bit sRGB RGB renders
 * (`maple_render_file`, `maple_render_bytes`).
 */
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
 * Scene-linear FFI buffer — Rec.2020 f32 RGBA, straight alpha, row-major.
 *
 * Additive sibling of [`MapleSceneLinearBuffer`] (fp16). #416 requires
 * the scene-referred buffer be carried as f32 end-to-end; fp16 is the
 * existing surface kept compiling for callers (Apple today) until they
 * migrate. New callers — Web first, Apple in a follow-up — should
 * prefer this entry to avoid banding from the fp16 mantissa loss.
 *
 * `bytes_per_pixel` is always 16 (4 channels × 4 bytes per f32 lane).
 * `channels` is always 4 (R, G, B, A). Free via
 * [`maple_free_scene_linear_buffer_f32`].
 */
typedef struct MapleSceneLinearBufferF32 {
  /**
   * Pointer to heap-allocated f32 RGBA buffer. Free via
   * `maple_free_scene_linear_buffer_f32`.
   */
  float *f32_rgba;
  /**
   * Bytes in the buffer (= 4 * 4 * width * height = 16 * width * height).
   */
  uintptr_t len_bytes;
  /**
   * Channels per pixel (always 4: R, G, B, A).
   */
  uint32_t channels;
  /**
   * Bytes per pixel (always 16 for f32 RGBA).
   */
  uint32_t bytes_per_pixel;
  uint32_t width;
  uint32_t height;
} MapleSceneLinearBufferF32;

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
  /**
   * User-selectable display Look (ticket #515). The byte is mapped
   * through `raw_core::view::look::Look::from(u8)`:
   *   - `0` = `Look::Neutral`  (identity, scene-referred output)
   *   - `1` = `Look::Default`  (empirical LUT — new-user default)
   * Hosts that have not been updated yet leave this at `1` (the
   * `AdjustmentModel::default()` Look).
   *
   * Placed at the end of the struct so adding the field does not shift
   * the offset of any earlier field — the FFI ABI for existing fields
   * stays binary-compatible with pre-#515 callers that re-bind to the
   * new header.
   */
  uint8_t look_mode;
} MapleAdjustmentParams;

/**
 * Compute Auto Tone slider values from a post-WB scene-linear RGBA f32
 * buffer.
 *
 * `scene_post_wb_rgba` must point to at least `4 * width * height` f32
 * lanes laid out as RGBA (the alpha lane is ignored). The buffer must
 * already be in `raw_core::image::ColorSpace::SceneLinearRec2020` — the
 * same colorspace produced by `maple_render_scene_linear_*_f32`.
 *
 * Phase 1a populates the `exposure` field only; the remaining five
 * fields are returned as 0.0 (slider rest position) so consumers can
 * write the recommendation back to their slider model with a single
 * memcpy.
 *
 * Returns:
 * - `0` on success — `*out` is populated.
 * - `-1` on a null pointer, a `width * height` overflow, or a
 *   `width * height * 4` overflow.
 *
 * # Safety
 * - `scene_post_wb_rgba` must point to at least `4 * width * height` f32
 *   values that remain valid for the duration of the call.
 * - `out` must point to a writable `MapleAutoTone`.
 */
int32_t maple_compute_auto_tone(const float *scene_post_wb_rgba,
                                uint32_t width,
                                uint32_t height,
                                struct MapleAutoTone *out);

/**
 * Free a buffer populated by `maple_render_file` or `maple_render_bytes`.
 */
void maple_free_buffer(struct MapleImageBuffer *buffer);

/**
 * Free a buffer populated by `maple_render_thumbnail_jpeg`.
 */
void maple_free_byte_buffer(struct MapleByteBuffer *buffer);

/**
 * Free a buffer populated by `maple_render_*_scene_linear`.
 */
void maple_free_scene_linear_buffer(struct MapleSceneLinearBuffer *buffer);

/**
 * Free a buffer populated by `maple_render_*_scene_linear_f32`.
 */
void maple_free_scene_linear_buffer_f32(struct MapleSceneLinearBufferF32 *buffer);

/**
 * Returns the most recent error message for the current thread, or null.
 * The returned pointer remains valid until the next FFI call on this thread.
 */
const char *maple_last_error(void);

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
 *   - 12: mismatched aspect — tile path requires `out_w/out_h` aspect
 *         to match `src_w/src_h` aspect (within integer rounding)
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
 * Compute BLAKE3 hex of arbitrary bytes. Output buffer must be at least 64
 * bytes (BLAKE3 is 256-bit → 64 hex chars). No null terminator — the caller
 * knows the length is exactly 64.
 *
 * Returns 0 on success, -1 on null pointers, -2 on zero-length input.
 */
int32_t maple_blake3_hex(const uint8_t *bytes_ptr, uintptr_t bytes_len, uint8_t *out_hex);

/**
 * Compute the spec-form **primary** maple_id over a file's leading bytes.
 * Output is the 32-character lowercase hex of the 16-byte tagged id
 * (`0x01 || BLAKE3(SHA1(head) || captured_at || serial || u64_le(shutter))[..15]`).
 *
 * Only the first `SHA1_HEAD_BYTES` (= 64 KB) of `head_ptr` feed `sha1Head`;
 * callers may safely pass exactly the first 64 KB rather than the whole
 * file. `captured_at_ptr` is hashed verbatim (UTF-8 bytes; the server's
 * indexer normalises the EXIF date to ISO 8601 before hashing — the device
 * must match that string byte-for-byte for dedup to fire).
 *
 * `serial_ptr` may be null (or `serial_len == 0`) — absent serial is
 * hashed as empty bytes, matching `MapleId::primary(_, _, None, _)`.
 *
 * `shutter_count == 0` is hashed as `0u64_le`, identical to
 * `MapleId::primary(_, _, _, None)`. The spec documents that a real
 * shutter-count of 0 collides with "absent" — this is by design.
 *
 * `out_hex` must point to at least 32 writable bytes. No null terminator.
 *
 * Returns:
 *   0  success
 *  -1  null pointer for `head_ptr`, `captured_at_ptr`, or `out_hex`
 *  -2  `head_len == 0`, `captured_at_len == 0`, OR `captured_at_ptr`
 *       does not decode as valid UTF-8 (the hash hashes its UTF-8 byte
 *       view, so non-UTF-8 input is rejected up front rather than hashed)
 */
int32_t maple_id_primary(const uint8_t *head_ptr,
                         uintptr_t head_len,
                         const uint8_t *captured_at_ptr,
                         uintptr_t captured_at_len,
                         const uint8_t *serial_ptr,
                         uintptr_t serial_len,
                         uint64_t shutter_count,
                         uint8_t *out_hex);

/**
 * Compute the spec-form **fallback** maple_id over a file's full bytes.
 * Output is the 32-character lowercase hex of the 16-byte tagged id
 * (`0x02 || BLAKE3(SHA1(all_bytes) || u64_le(filesize))[..15]`).
 *
 * `filesize` is typically `bytes_len` but is passed separately so callers
 * streaming or aliasing buffers can pass the canonical file size
 * independently (matches the spec formula).
 *
 * `out_hex` must point to at least 32 writable bytes. No null terminator.
 *
 * Returns:
 *   0  success
 *  -1  null pointer for `bytes_ptr` or `out_hex`
 *  -2  `bytes_len == 0`
 */
int32_t maple_id_fallback(const uint8_t *bytes_ptr,
                          uintptr_t bytes_len,
                          uint64_t filesize,
                          uint8_t *out_hex);

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
 * Render a RAW+XMP through the full 8-bit sRGB pipeline (identical decode +
 * develop path to `maple_render_file`) and write a 3×256 channel histogram of
 * the result into the caller-provided `out_bins` buffer.
 *
 * `out_bins` must point to at least [`HISTOGRAM_BINS_LEN`] (`768`) writable
 * `u32`s; the layout is channel-major (`[0,256)` = R counts, `[256,512)` = G,
 * `[512,768)` = B). It is overwritten in full on success and untouched on error.
 *
 * Crucially the rendered pixel buffer never crosses the FFI boundary: it is
 * binned in Rust and only the 3 KB histogram is returned, through a buffer the
 * *caller* owns. This sidesteps the `toBuffer`-over-Rust-memory lifetime trap
 * that segfaults the JSC heap on a later GC (the same reasoning that moved the
 * thumbnail path to the `_to_file` entry — see `buffers.rs`). It also avoids
 * shipping ~300 MB of RGB across the boundary for a 100 MP frame.
 *
 * Returns 0 on success, non-zero on error (call `maple_last_error`). Error
 * codes mirror `maple_render_file` plus the shared XMP-load codes:
 * 1 = null or misaligned `out_bins` pointer, 2/3 = raw/xmp path not UTF-8,
 * 4 = XMP parse, 5 = XMP read, 6 = raw read, 7 = decode, 8 = render.
 * Codes 4 and 5 surface from `load_xmp_model_owned` only when an `xmp_path`
 * is supplied (a malformed or unreadable sidecar).
 *
 * # Safety
 *
 * `raw_path` must be a valid C string; `xmp_path` may be null or a valid C
 * string; `out_bins` must point to >= [`HISTOGRAM_BINS_LEN`] writable `u32`s
 * that live for the duration of the call. Misalignment is rejected at runtime
 * (returns 1) rather than risking UB in the `from_raw_parts_mut` write below.
 */
int32_t maple_histogram_file(const char *raw_path, const char *xmp_path, uint32_t *out_bins);

/**
 * Writes 768 bytes (256 R, then 256 G, then 256 B) into `out` — the byte
 * layout an Apple Metal `MTLTexture` (3 × `r8Unorm`, 256×1) or a Web
 * WebGL2 `R8` 1D LUT texture expects, packed in channel-major order so
 * the host can upload three contiguous 256-byte regions in one staging
 * buffer.
 *
 * `look_mode` matches the `Look::from(u8)` mapping (`0` = `Neutral`,
 * `1` = `Default`). Unknown bytes return `-1` without touching `out`.
 *
 * Returns `0` on success, `-1` if `out` is null OR `look_mode` is not
 * one of the documented variants. The error path does not set
 * `maple_last_error` — the caller has the look_mode in hand and a null
 * pointer is its own diagnostic; this entry is deliberately small.
 *
 * Apple + Web hosts call this once per render to seed a GPU LUT texture
 * (the texture stays valid until the user changes `look_mode`, so this
 * is not per-tick — see ticket #515 § L3).
 *
 * # Safety
 *
 * `out` must point to a writable buffer of at least 768 bytes that lives
 * for the duration of the call. The buffer is overwritten unconditionally
 * on success and is not touched on error.
 */
int32_t maple_compute_look_lut(uint8_t look_mode, uint8_t *out);

/**
 * Bake a fitted Auto Profile curve into a display-space `n³` 3D LUT (#817)
 * and write it as `n * n * n * 3` f32 values into `out`.
 *
 * `curve` points to `curve_len` f32 values — the flat serialization of a
 * `raw_core::view::auto_profile::ProfileCurve` produced by its `to_flat()`
 * (length `raw_core::view::auto_profile::PROFILE_CURVE_FLAT_LEN`). The LUT is
 * JUST the canonical `apply_curve` sampled over a regular `[0, 1]³` grid, so
 * the GPU sampler that uploads these bytes (Apple Metal #812, Web WebGL2
 * #394) cannot drift from the CPU render path.
 *
 * **Layout** (matches `raw_core::view::auto_profile::bake_profile_lut`):
 * `n³` RGB triplets, R varying fastest, then G, then B —
 * `out[((b*n + g)*n + r)*3 + c]`. Grid coordinate `k` maps to display value
 * `k / (n - 1)`.
 *
 * This is a **per-image, one-shot** call — the fitted curve is keyed on the
 * embedded JPEG (stable across slider edits), so the host bakes once when the
 * curve is first fit and re-samples the GPU texture every slider tick WITHOUT
 * re-baking. Never call this per tick.
 *
 * Returns:
 * - `0` on success — `out` is fully written.
 * - `-1` if `curve` or `out` is null, `curve_len` is not exactly
 *   `PROFILE_CURVE_FLAT_LEN`, `n < 2`, `n > MAX_LUT_SIZE`, or `n³ * 3` would
 *   overflow `usize`.
 *   The error path does not set `maple_last_error` (the caller owns the
 *   curve bytes + `n` and a null/short buffer is its own diagnostic).
 *
 * # Safety
 * - `curve` must point to at least `curve_len` readable f32 values.
 * - `out` must point to a writable buffer of at least `n * n * n * 3` f32
 *   values that lives for the duration of the call. It is overwritten on
 *   success and untouched on error.
 */
int32_t maple_compute_profile_lut(const float *curve, uintptr_t curve_len, uint32_t n, float *out);

/**
 * Fit the per-image Auto Profile curve (#812) for a RAW file + XMP sidecar
 * and write its flat serialization into `out`.
 *
 * This is the FITTED-curve sibling of `maple_compute_profile_lut` (which
 * BAKES an already-fitted curve into a 3D LUT). The gap #840 flagged: the
 * bake entry took a serialized curve as INPUT, but nothing surfaced the
 * fit across FFI. This export closes that — the Apple Metal host (#812)
 * calls it once per image to obtain the curve, then feeds the result
 * straight into `maple_compute_profile_lut` to bake the GPU LUT.
 *
 * It delegates to `raw_core::pipeline::fit_profile_curve_from_raw`, which
 * develops the RAW through the SAME view-transform prefix the CPU render
 * uses (AgX → rec2020→sRGB → sRGB gamma encode) and fits the curve in
 * f32 sRGB-encoded display space — so the GPU Auto Profile render cannot
 * drift from `maple_render_file`'s CPU Auto Profile output.
 *
 * `quality_preview` mirrors `maple_render_file`: `0` = `RenderQuality::Full`
 * (matches the parity harness / `maple-cli render`), `1` = `Preview`
 * (half-res develop). Pass the same value the host's scene-linear decode
 * used so the fitted curve matches the buffer being displayed.
 *
 * `out` must point to at least `PROFILE_CURVE_FLAT_LEN` writable f32. On
 * success the full flat curve is written and `0` is returned.
 *
 * This is a **per-image, one-shot** call — the fit runs a full JPEG
 * extraction + develop chain (orders of magnitude over the slider tick
 * budget). The fit is cached in the shared `auto_profile` LRU keyed on
 * `(raw_identity, mtime)`, so the host should ALSO cache the returned
 * curve on its side and never call this per slider tick.
 *
 * Returns:
 * - `0` on success — `out` holds `PROFILE_CURVE_FLAT_LEN` f32.
 * - `1` when no curve applies — the model is not `Profile::Auto`, the
 *   embedded JPEG can't be extracted, or the fit is degenerate. `out` is
 *   left untouched; the host renders plain AgX (= `Profile::Neutral`).
 * - `2`/`3` when `raw_path` / `xmp_path` is non-UTF-8.
 * - `6`/`7` when the RAW read / decode fails (`maple_last_error` is set).
 * - `9` on an internal invariant failure — the fitted curve did not serialize
 *   to `PROFILE_CURVE_FLAT_LEN` (a layout bug, never a caller error;
 *   `maple_last_error` is set). Distinct from `-1` so a host can tell this
 *   apart from a null-pointer argument.
 * - `-1` when `raw_path` or `out` is null.
 *
 * # Safety
 * - `raw_path` must be a valid UTF-8 C string; `xmp_path` may be null.
 * - `out` must point to at least `PROFILE_CURVE_FLAT_LEN` writable f32 that
 *   live for the duration of the call. It is overwritten only on success.
 */
int32_t maple_compute_profile_curve(const char *raw_path,
                                    const char *xmp_path,
                                    int32_t quality_preview,
                                    float *out);

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
 * Plan 1 v2 — see .archived-plans/plans/2026-04-24-ffi-split-plan-1.md
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
 * `(src_x, src_y, src_w, src_h)`. Pads internally by
 * `raw_core::pipeline::TILE_OVERLAP_PX` to satisfy the
 * development chain's stencil radii (clarity is the binding
 * constraint), then trims to the inner rect, downsamples to
 * `(out_w, out_h)`, orients, and packs to fp16 RGBA.
 *
 * Returns 0 on success. Error codes mirror `maple_render_file_scene_linear`
 * plus:
 *   - 9:  `src_w/src_h/out_w/out_h == 0` — bad tile geometry.
 *   - 10: `model.dehaze != 0` — tile path is not supported (radius 67
 *          exceeds the overlap pad). Caller should fall back to
 *          fit-zoom rendering.
 *   - 11: `out_w > src_w || out_h > src_h` — tile path is downscale-only.
 *   - 12: `(out_w, out_h)` aspect does not match `(src_w, src_h)` —
 *          tile path requires matching aspect.
 *
 * Plan 3 — see .archived-plans/plans/2026-04-25-deep-zoom-tile-rendering.md
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
 * f32 sibling of [`maple_render_file_scene_linear`]. Identical inputs
 * and error codes; the output buffer is [`MapleSceneLinearBufferF32`]
 * (16 bytes per pixel) instead of the fp16 surface.
 */
int32_t maple_render_file_scene_linear_f32(const char *raw_path,
                                           const char *xmp_path,
                                           int32_t quality_preview,
                                           struct MapleSceneLinearBufferF32 *out);

/**
 * f32 sibling of [`maple_render_bytes_scene_linear`].
 */
int32_t maple_render_bytes_scene_linear_f32(const uint8_t *raw_bytes,
                                            uintptr_t raw_len,
                                            const char *hint_ext,
                                            const char *xmp_path,
                                            int32_t quality_preview,
                                            struct MapleSceneLinearBufferF32 *out);

/**
 * f32 sibling of [`maple_render_file_scene_linear_sized`].
 */
int32_t maple_render_file_scene_linear_sized_f32(const char *raw_path,
                                                 const char *xmp_path,
                                                 uint32_t max_long_edge,
                                                 int32_t quality_preview,
                                                 struct MapleSceneLinearBufferF32 *out);

/**
 * f32 sibling of [`maple_render_bytes_scene_linear_sized`].
 */
int32_t maple_render_bytes_scene_linear_sized_f32(const uint8_t *raw_bytes,
                                                  uintptr_t raw_len,
                                                  const char *hint_ext,
                                                  const char *xmp_path,
                                                  uint32_t max_long_edge,
                                                  int32_t quality_preview,
                                                  struct MapleSceneLinearBufferF32 *out);

/**
 * Run the cheap-stage scene-linear chain over a caller-provided fp16 RGBA
 * buffer. Returns 0 on success, non-zero on error (call `maple_last_error`).
 *
 * `in_ptr` and `out_ptr` MUST point to buffers of size
 * `8 * width * height` bytes (= `4 * width * height` fp16 lanes). The
 * caller owns both buffers. This entry does not free anything, but does
 * perform one intermediate heap allocation of the same size as the output
 * buffer (the wrapped `raw_core` entry returns an owned `Vec<u16>` which
 * is then copied into `out_ptr`).
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
 * f32 sibling of [`maple_apply_scene_linear_chain`]. Identical semantics
 * (same stage order, same `MapleAdjustmentParams` struct, same error
 * codes) — the only difference is the buffer surface: input and output
 * are both packed f32 RGBA, row-major, 4 lanes per pixel
 * (`bytes_per_pixel = 16`).
 *
 * Added in #487 to unblock the Apple end-to-end f32 migration: with the
 * fp16 entry, an f32 scene buffer would silently round-trip back to fp16
 * every slider tick, defeating the precision win of #482. New callers
 * holding a f32 scene buffer should prefer this entry.
 *
 * `in_ptr` and `out_ptr` MUST point to buffers of size
 * `16 * width * height` bytes (= `4 * width * height` f32 lanes). The
 * caller owns both buffers. Like the fp16 sibling this entry performs
 * one intermediate heap allocation of the same size as the output
 * buffer (the wrapped `raw_core` entry returns an owned `Vec<f32>`
 * which is then copied into `out_ptr`).
 *
 * Returns 0 on success, non-zero on error (call `maple_last_error`).
 */
int32_t maple_apply_scene_linear_chain_f32(const float *in_ptr,
                                           uint32_t width,
                                           uint32_t height,
                                           const struct MapleAdjustmentParams *params,
                                           float *out_ptr);

/**
 * Apply the canonical display **encode** to a post-AgX **display-linear
 * Rec.2020** f32 RGBA buffer: hue-preserving Oklab gamut compression
 * (`rec2020_to_srgb`, #438) followed by `srgb_gamma_encode`. Returns
 * **sRGB-gamma-encoded sRGB-primary** f32 RGBA.
 *
 * This is the exact pair of view-encode stages the CPU/CLI reference runs
 * between AgX and the Auto Profile cube (`agx → rec2020_to_srgb →
 * srgb_gamma_encode → auto_profile`). The Apple canvas previously reached
 * sRGB implicitly at the CoreImage `createCGImage` boundary, which does a
 * per-channel clamp of the Rec.2020→sRGB matrix output — NOT the Oklab
 * chroma compression — so saturated wide-gamut greens clipped and diverged
 * from the reference (#871 / #877). Routing the Apple encode through this
 * entry makes the canvas gamut-correct by construction (it shares raw-core's
 * reference math), and lands the buffer in the [0,1]³ sRGB-gamma-encoded
 * sRGB-primary space the Auto Profile cube was fit/baked in, so the cube
 * applies on the matching domain.
 *
 * `in_ptr` and `out_ptr` MUST point to buffers of size
 * `16 * width * height` bytes (= `4 * width * height` f32 lanes). The caller
 * owns both buffers. Like the chain entries this performs one intermediate
 * heap allocation of the output size (the wrapped `raw_core` entry returns
 * an owned `Vec<f32>` copied into `out_ptr`). `out_ptr` may alias `in_ptr`.
 *
 * Returns 0 on success, non-zero on error (call `maple_last_error`).
 */
int32_t maple_encode_display_srgb_f32(const float *in_ptr,
                                      uint32_t width,
                                      uint32_t height,
                                      float *out_ptr);

/**
 * Extract an embedded JPEG preview / thumbnail from `raw_path`, downsample
 * to `max_px` on the long edge if necessary, then JPEG-encode the result.
 *
 * Returns 0 on success; sets `out` to a `MapleByteBuffer` the caller must
 * free via `maple_free_byte_buffer`. Non-zero on error.
 *
 * `quality` is JPEG quality in [1, 100]. Spec-pinned default is 82; pass 0
 * to use the default. Values > 100 are rejected (rc 14) — `u8` allows up
 * to 255 and the JPEG encoder accepts anything > 100 silently, which is
 * not what callers mean.
 */
int32_t maple_render_thumbnail_jpeg(const char *raw_path,
                                    uint32_t max_px,
                                    uint8_t quality,
                                    struct MapleByteBuffer *out);

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
 * `quality` is JPEG quality in [1, 100]; pass 0 to use the default (82).
 * Values > 100 are rejected with rc 14.
 *
 * Returns 0 on success; non-zero on error (call `maple_last_error`).
 */
int32_t maple_render_thumbnail_jpeg_to_file(const char *raw_path,
                                            const char *out_path,
                                            uint32_t max_px,
                                            uint8_t quality);
