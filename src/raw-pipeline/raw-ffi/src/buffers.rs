//! `#[repr(C)]` output buffers and their matching `*_free_*` entry points.
//!
//! Every render entry hands the caller a heap-allocated buffer whose
//! ownership crosses the FFI boundary; freeing must go back through a
//! matching FFI call so Rust's allocator owns the lifecycle end-to-end.

/// Output buffer for the legacy 8-bit sRGB RGB renders
/// (`maple_render_file`, `maple_render_bytes`).
#[repr(C)]
pub struct MapleImageBuffer {
    /// Pointer to heap-allocated RGB u8 buffer. Free via `maple_free_buffer`.
    pub rgb: *mut u8,
    /// Bytes in the buffer (= 3 * width * height).
    pub len: usize,
    pub width: u32,
    pub height: u32,
}

impl MapleImageBuffer {
    pub(crate) fn empty() -> Self {
        Self {
            rgb: std::ptr::null_mut(),
            len: 0,
            width: 0,
            height: 0,
        }
    }
}

/// Free a buffer populated by `maple_render_file` or `maple_render_bytes`.
#[no_mangle]
pub unsafe extern "C" fn maple_free_buffer(buffer: *mut MapleImageBuffer) {
    if buffer.is_null() {
        return;
    }
    let b = &mut *buffer;
    if !b.rgb.is_null() {
        let slice = std::slice::from_raw_parts_mut(b.rgb, b.len);
        drop(Box::from_raw(slice as *mut [u8]));
    }
    *b = MapleImageBuffer::empty();
}

/// Scene-linear FFI buffer — Rec.2020 fp16 RGBA, straight alpha, row-major.
///
/// `bytes_per_pixel` is always 8 (4 channels × 2 bytes per fp16 lane). It
/// is exposed in the struct so the Apple consumer can read the layout
/// without hard-coding the constant; future plans (e.g. higher bit depth
/// for HDR) can change it without breaking the ABI.
#[repr(C)]
pub struct MapleSceneLinearBuffer {
    /// Pointer to heap-allocated fp16 RGBA buffer. Free via
    /// `maple_free_scene_linear_buffer`.
    pub fp16_rgba: *mut u16,
    /// Bytes in the buffer (= 4 * 2 * width * height = 8 * width * height).
    pub len_bytes: usize,
    /// Channels per pixel (always 4: R, G, B, A).
    pub channels: u32,
    /// Bytes per pixel (always 8 for fp16 RGBA).
    pub bytes_per_pixel: u32,
    pub width: u32,
    pub height: u32,
}

impl MapleSceneLinearBuffer {
    pub(crate) fn empty() -> Self {
        Self {
            fp16_rgba: std::ptr::null_mut(),
            len_bytes: 0,
            channels: 0,
            bytes_per_pixel: 0,
            width: 0,
            height: 0,
        }
    }
}

/// Free a buffer populated by `maple_render_*_scene_linear`.
#[no_mangle]
pub unsafe extern "C" fn maple_free_scene_linear_buffer(buffer: *mut MapleSceneLinearBuffer) {
    if buffer.is_null() {
        return;
    }
    let b = &mut *buffer;
    if !b.fp16_rgba.is_null() {
        let len_lanes = b.len_bytes / std::mem::size_of::<u16>();
        let slice = std::slice::from_raw_parts_mut(b.fp16_rgba, len_lanes);
        drop(Box::from_raw(slice as *mut [u16]));
    }
    *b = MapleSceneLinearBuffer::empty();
}

/// Scene-linear FFI buffer — Rec.2020 f32 RGBA, straight alpha, row-major.
///
/// Additive sibling of [`MapleSceneLinearBuffer`] (fp16). #416 requires
/// the scene-referred buffer be carried as f32 end-to-end; fp16 is the
/// existing surface kept compiling for callers (Apple today) until they
/// migrate. New callers — Web first, Apple in a follow-up — should
/// prefer this entry to avoid banding from the fp16 mantissa loss.
///
/// `bytes_per_pixel` is always 16 (4 channels × 4 bytes per f32 lane).
/// `channels` is always 4 (R, G, B, A). Free via
/// [`maple_free_scene_linear_buffer_f32`].
#[repr(C)]
pub struct MapleSceneLinearBufferF32 {
    /// Pointer to heap-allocated f32 RGBA buffer. Free via
    /// `maple_free_scene_linear_buffer_f32`.
    pub f32_rgba: *mut f32,
    /// Bytes in the buffer (= 4 * 4 * width * height = 16 * width * height).
    pub len_bytes: usize,
    /// Channels per pixel (always 4: R, G, B, A).
    pub channels: u32,
    /// Bytes per pixel (always 16 for f32 RGBA).
    pub bytes_per_pixel: u32,
    pub width: u32,
    pub height: u32,
    /// Per-camera noise profile from `RawImage::noise_profile` (PR #1709
    /// review finding). Null when the source DNG carries no NoiseLevelFunction
    /// tag — the per-tick chain then falls back to the ISO-only estimate.
    /// Free via `maple_free_scene_linear_buffer_f32` — do NOT free separately.
    /// `noise_profile_len` f32 values, heap-allocated and owned by this struct.
    pub noise_profile_data: *mut f32,
    /// Number of f32 values at `noise_profile_data`. 0 when `noise_profile_data`
    /// is null.
    pub noise_profile_len: u32,
    /// ISO speed at capture from `RawImage::iso`. 0 when the source DNG did not
    /// carry an ISO tag (the chain substitutes 100 on the Rust side).
    pub iso: u32,
    // --- WB slider frame export (#1781). The resolved
    //     `wb_camera::SliderFrame` this buffer was developed under, plus the
    //     frame's as-shot `(scene_cct, tint)` estimate — the data the host
    //     passes back through `MapleAdjustmentParams.wb_frame_*` /
    //     `MapleGpuLiveParams.wb_frame_*` so the per-tick WB delta is derived
    //     in the SAME calibration frame the develop chain used, and seeds its
    //     As-Shot slider values from raw-core's numbers instead of a
    //     platform-estimated pre-decode placeholder. All six fields are 0 when
    //     no frame applies (`RawlerFallback` body, lossy LinearRaw) — hosts
    //     treat `wb_frame_scene_cct <= 0` as "absent" and keep their legacy
    //     behaviour. Appended at the struct tail per the offset-stable ABI
    //     convention (inline values, nothing extra to free). ---
    /// Cold calibration endpoint (XYZ→camera), row-major 3×3.
    pub wb_frame_m_cold: [f32; 9],
    pub wb_frame_cct_cold: f32,
    /// Warm calibration endpoint (XYZ→camera), row-major 3×3. Equal to the
    /// cold endpoint (with equal CCTs) for a single-calibration frame.
    pub wb_frame_m_warm: [f32; 9],
    pub wb_frame_cct_warm: f32,
    /// The frame's as-shot CCT (the slider identity temperature). 0 ⇒ absent.
    pub wb_frame_scene_cct: f32,
    /// The frame's as-shot tint (in-frame estimate; may sit at the ±100 rail
    /// for bodies whose as-shot chromaticity is far off the Planckian locus).
    pub wb_frame_as_shot_tint: f32,
    /// The RENDER PROFILE's CM (row-major 3×3, XYZ→camera — the
    /// conjugation basis the post-DCP WB delta is built in (#1904
    /// GPU-live seam fix) when the #1967 fields below are absent. Zero ⇒
    /// host predates #1904.
    pub wb_frame_render_cm: [f32; 9],
    // --- #1967: render-profile linear-core detail — see
    //     `MapleGpuLiveParams`'s matching tail for the field-by-field
    //     semantics; this is the decode-side export of the same data. ---
    pub wb_frame_render_forward_matrix: [f32; 9],
    pub wb_frame_render_scene_white_xyz: [f32; 3],
    pub wb_frame_render_wb_already_baked: f32,
    pub wb_frame_render_cm_cold: [f32; 9],
    pub wb_frame_render_cct_cold: f32,
    pub wb_frame_render_cm_warm: [f32; 9],
    pub wb_frame_render_cct_warm: f32,
    pub wb_frame_render_fm_cold: [f32; 9],
    pub wb_frame_render_fm_warm: [f32; 9],
    /// Auto-exposure anchor gain (#1167) the develop chain's `auto_exposure`
    /// stage actually applied to this buffer's pixels: `clamp(0.18 /
    /// midgrey, max = 8.0)` (or the highlight-candidate variant — see
    /// `stages::auto_exposure`), or exactly `1.0` when
    /// `papp:AutoExposure="Off"`. Informational/export-only — the gain is
    /// already baked into `f32_rgba`. Hosts pass this straight through to a
    /// tile-develop call (`maple_render_handle_scene_linear_tile_ae_f32`'s
    /// `ae_gain` parameter) so a deep-zoom tile of the SAME model reproduces
    /// the full-image AE gain instead of omitting the stage. Appended at the
    /// struct tail per the offset-stable ABI convention (inline scalar,
    /// nothing to free).
    pub ae_gain: f32,
}

impl MapleSceneLinearBufferF32 {
    pub(crate) fn empty() -> Self {
        Self {
            f32_rgba: std::ptr::null_mut(),
            len_bytes: 0,
            channels: 0,
            bytes_per_pixel: 0,
            width: 0,
            height: 0,
            noise_profile_data: std::ptr::null_mut(),
            noise_profile_len: 0,
            iso: 0,
            wb_frame_m_cold: [0.0; 9],
            wb_frame_cct_cold: 0.0,
            wb_frame_m_warm: [0.0; 9],
            wb_frame_cct_warm: 0.0,
            wb_frame_scene_cct: 0.0,
            wb_frame_as_shot_tint: 0.0,
            wb_frame_render_cm: [0.0; 9],
            wb_frame_render_forward_matrix: [0.0; 9],
            wb_frame_render_scene_white_xyz: [0.0; 3],
            wb_frame_render_wb_already_baked: 0.0,
            wb_frame_render_cm_cold: [0.0; 9],
            wb_frame_render_cct_cold: 0.0,
            wb_frame_render_cm_warm: [0.0; 9],
            wb_frame_render_cct_warm: 0.0,
            wb_frame_render_fm_cold: [0.0; 9],
            wb_frame_render_fm_warm: [0.0; 9],
            ae_gain: 1.0,
        }
    }
}

/// Free a buffer populated by `maple_render_*_scene_linear_f32`.
#[no_mangle]
pub unsafe extern "C" fn maple_free_scene_linear_buffer_f32(
    buffer: *mut MapleSceneLinearBufferF32,
) {
    if buffer.is_null() {
        return;
    }
    let b = &mut *buffer;
    if !b.f32_rgba.is_null() {
        let len_lanes = b.len_bytes / std::mem::size_of::<f32>();
        let slice = std::slice::from_raw_parts_mut(b.f32_rgba, len_lanes);
        drop(Box::from_raw(slice as *mut [f32]));
    }
    // Free the noise profile if it was populated.
    if !b.noise_profile_data.is_null() {
        let slice =
            std::slice::from_raw_parts_mut(b.noise_profile_data, b.noise_profile_len as usize);
        drop(Box::from_raw(slice as *mut [f32]));
    }
    *b = MapleSceneLinearBufferF32::empty();
}
