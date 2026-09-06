//! [`MapleGpuLiveParams`]' own field definition — split out of `gpu_live.rs`
//! (tools/check-budget-headroom.sh) purely because the struct's per-field-group
//! doc comments are long, not because it's logically separate; it belongs to
//! `gpu_live.rs`'s FFI surface and is re-exported from there.

/// C-ABI live-render params for the GPU chain (gpu-gated; see the module docs on
/// why this is separate from [`crate::MapleAdjustmentParams`]). Scalars inline;
/// variable-length arrays as `(ptr, len)` pairs the caller owns for the duration
/// of the render call.
///
/// All point arrays are flat `f32` pairs (`[x0, y0, x1, y1, …]`), so a `len` is
/// the FLOAT count (= 2 × point count). The Auto Profile curve is the
/// `ProfileCurve::to_flat()` layout (`raw_gpu::PROFILE_CURVE_FLAT_LEN` floats);
/// the residual LUT is `size³ × 3` floats.
#[repr(C)]
pub struct MapleGpuLiveParams {
    // --- white balance (the matrix is derived Rust-side from temp/tint via the
    //     same `wb_cat16_matrix` the CPU chain uses, so the live builder's WB
    //     gate sees the canonical temp/tint, not a host-derived matrix) ---
    pub temperature: f32,
    pub tint: f32,
    /// WB method: 0 = CAT16 (default), 1 = diagonal Rec.2020.
    pub wb_method: u32,
    // --- scene tone controls (exposure in EV; the rest [-100, 100]) ---
    pub exposure: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    // --- AgX contrast (routed to the sigmoid slope) ---
    pub contrast: f32,
    // --- parametric tone-curve region sliders (shadows, darks, lights, highlights) ---
    pub parametric_shadows: f32,
    pub parametric_darks: f32,
    pub parametric_lights: f32,
    pub parametric_highlights: f32,
    /// Tone-curve per-channel mode: 0 = PerChannel, 1 = RatioPreserving.
    pub tone_curve_mode: u32,
    // --- color / spatial sliders ([-100, 100] / [0, 100]) ---
    pub vibrance: f32,
    pub saturation: f32,
    pub clarity: f32,
    pub texture: f32,
    pub dehaze: f32,
    pub sharpen_amount: f32,
    pub sharpen_radius: f32,
    pub sharpen_detail: f32,
    pub sharpen_masking: f32,
    pub nr_luminance: f32,
    pub nr_color: f32,
    // --- capture sharpening (only applied when `capture_sharpening_enabled != 0`;
    //     the decode-boundary contract bakes it on Apple, so the live path passes
    //     it disabled there — see the plan — but the core entry supports it) ---
    pub capture_sharpening_enabled: u32,
    pub capture_sharpening_sigma: f32,
    pub capture_sharpening_iterations: u32,
    pub capture_sharpening_highlight_threshold: f32,
    pub capture_sharpening_strength: f32,
    // --- user tone curves: flat (x, y) f32 pairs; len = float count (2× points) ---
    pub tone_curve_luma_ptr: *const f32,
    pub tone_curve_luma_len: usize,
    pub tone_curve_red_ptr: *const f32,
    pub tone_curve_red_len: usize,
    pub tone_curve_green_ptr: *const f32,
    pub tone_curve_green_len: usize,
    pub tone_curve_blue_ptr: *const f32,
    pub tone_curve_blue_len: usize,
    // --- Auto Profile fitted curve (flat; PROFILE_CURVE_FLAT_LEN floats) ---
    pub profile_curve_ptr: *const f32,
    pub profile_curve_len: usize,
    // --- Auto Profile residual 3D LUT (size³ × 3 floats) ---
    pub residual_lut_size: u32,
    pub residual_lut_ptr: *const f32,
    pub residual_lut_len: usize,
    // --- brightness — scene-linear midtone-band gain, [-100, 100] (#1102,
    //     tone/zoom design § 4.1; runs between exposure and highlights) ---
    //
    // Placed at the END of the struct (after the array pointers) so adding
    // the field does not shift the offset of any earlier field — same
    // append-only ABI convention as `MapleAdjustmentParams::look_mode`. A
    // host built against the pre-#1102 header that re-binds to the new one
    // sees every existing field at its old offset; an un-set tail field
    // reads as 0.0 = identity.
    pub brightness: f32,
    // --- vignette — scene-linear radial EV gain (#1109, tone/zoom design
    //     § 10.1; runs between dehaze and sharpen). Appended at the tail
    //     per the same convention: un-set amount reads 0.0 = identity
    //     (feather is inert at amount 0). ---
    pub vignette_amount: f32,
    pub vignette_feather: f32,
    // --- film grain — display-linear deterministic noise (#1110, tone/zoom
    //     design § 10.2; runs between agx and display_encode). Appended at
    //     the tail; un-set amount reads 0.0 = identity. ---
    pub grain_amount: f32,
    pub grain_size: f32,
    pub grain_roughness: f32,
    // --- split toning — display-linear Oklab tint (#1111, tone/zoom design
    //     § 10.3; runs between agx and grain). Appended at the tail; un-set
    //     saturations read 0.0 = identity. ---
    pub split_tone_shadow_hue: f32,
    pub split_tone_shadow_saturation: f32,
    pub split_tone_highlight_hue: f32,
    pub split_tone_highlight_saturation: f32,
    pub split_tone_balance: f32,
    // --- HSL 8-band per-channel adjustments — scene-linear Oklab (#1112,
    //     tone/zoom design § 10.4; runs after saturation / before clarity).
    //     Appended at the tail per the same ABI convention; un-set fields
    //     read as 0.0 = identity. ---
    pub hsl_hue_red: f32,
    pub hsl_hue_orange: f32,
    pub hsl_hue_yellow: f32,
    pub hsl_hue_green: f32,
    pub hsl_hue_aqua: f32,
    pub hsl_hue_blue: f32,
    pub hsl_hue_purple: f32,
    pub hsl_hue_magenta: f32,
    pub hsl_sat_red: f32,
    pub hsl_sat_orange: f32,
    pub hsl_sat_yellow: f32,
    pub hsl_sat_green: f32,
    pub hsl_sat_aqua: f32,
    pub hsl_sat_blue: f32,
    pub hsl_sat_purple: f32,
    pub hsl_sat_magenta: f32,
    pub hsl_lum_red: f32,
    pub hsl_lum_orange: f32,
    pub hsl_lum_yellow: f32,
    pub hsl_lum_green: f32,
    pub hsl_lum_aqua: f32,
    pub hsl_lum_blue: f32,
    pub hsl_lum_purple: f32,
    pub hsl_lum_magenta: f32,
    // --- decoded WB (the WB the buffer being rendered was decoded at — #1240
    //     follow-up). The chain's WB step computes `M_net = M_live · M_decoded⁻¹`
    //     instead of `M_live` alone, mirroring `apply_delta`: identity at
    //     `live == decoded` (post-DCP D65 buffer, slider at as-shot CCT), shift
    //     relative to as-shot otherwise. Without this, the GPU chain applied
    //     `M_live` ABSOLUTELY from D65 and the editor canvas rendered the as-shot
    //     scene with `wb_cat16(asShot)` baked in (e.g. test_0002 → uniform colour
    //     cast user reported). Appended at the tail per the ABI convention; an
    //     un-set host (zero/zero) reads as "decoded == 6500/0", collapsing the
    //     ratio to the absolute apply that earlier hosts expected.
    pub decoded_temperature: f32,
    pub decoded_tint: f32,
    // --- target display primaries — view-tail display_encode matrix (#1337).
    //     Appended at the tail per the append-only ABI convention; a legacy
    //     host that zero-initializes reads 0 = sRGB (the pre-#1337 default,
    //     bit-identical output). 1 = Display P3 (SMPTE RP 431-2, D65). ---
    pub target_primaries: u32,
    // --- input shape tag (#1331) — appended after target_primaries. 0 =
    //     PostDcpRec2020Fp16 (RAW, all stages), 1 = LinearRec2020Fp16 (pano,
    //     skip CS only — WB stays engaged), 2 = SrgbGammaEncoded8 (JPEG/HEIF,
    //     CPU pre-pass). A stale host leaves this 0 = the historic RAW path;
    //     bit-exact. ---
    pub input_shape: u32,
    // --- WB slider frame (#1781) — the decode-exported `SliderFrame` data
    //     (`MapleSceneLinearBufferF32.wb_frame_*`, passed back verbatim by
    //     the host). When present (`wb_frame_scene_cct > 0`) AND a decoded
    //     anchor is engaged, the WB matrix is derived in this frame via the
    //     same `wb_camera` math the CPU develop uses, instead of the generic
    //     Planckian CAT16 delta — closing the live-vs-refine seam. Appended
    //     at the tail per the append-only ABI convention: a stale host
    //     zero-fills all six fields ⇒ frame absent ⇒ the legacy CAT16 path,
    //     bit-identical output (asserted by
    //     `zero_frame_params_reproduce_legacy_wb_matrix`). ---
    /// Cold calibration endpoint (XYZ→camera), row-major 3×3.
    pub wb_frame_m_cold: [f32; 9],
    pub wb_frame_cct_cold: f32,
    /// Warm calibration endpoint (XYZ→camera), row-major 3×3. Equal to the
    /// cold endpoint (with equal CCTs) for a single-calibration frame.
    pub wb_frame_m_warm: [f32; 9],
    pub wb_frame_cct_warm: f32,
    /// The frame's as-shot CCT (the slider identity temperature). 0 ⇒ the
    /// whole frame block is absent (legacy behaviour).
    pub wb_frame_scene_cct: f32,
    /// The frame's as-shot tint (in-frame estimate).
    pub wb_frame_as_shot_tint: f32,
    /// The RENDER PROFILE's CM (row-major 3×3, XYZ→camera — the
    /// conjugation basis the post-DCP WB delta is built in (#1904
    /// GPU-live seam fix) when the #1967 fields below are absent. Zero ⇒
    /// host predates #1904.
    pub wb_frame_render_cm: [f32; 9],
    // --- #1967: render-profile linear-core detail, enabling an EXACT
    //     per-target/per-anchor conjugation basis instead of the single
    //     fixed `wb_frame_render_cm`. Appended at the struct tail per the
    //     offset-stable ABI convention: a stale host leaves every field
    //     below 0/absent ⇒ the #1904 fixed-C fallback, bit-identical
    //     output. ---
    /// `profile.forward_matrix`, row-major 3×3. All-zero ⇒ `None`.
    pub wb_frame_render_forward_matrix: [f32; 9],
    /// `profile.scene_white_xyz`, Y-normalized.
    pub wb_frame_render_scene_white_xyz: [f32; 3],
    /// `profile.wb_already_baked` as a 0.0/1.0 flag.
    pub wb_frame_render_wb_already_baked: f32,
    /// Render profile's own dual-illuminant CM pair (distinct from
    /// `wb_frame_m_cold`/`wb_frame_m_warm` above, which are the VALUE
    /// frame's). Span `< 1.0` ⇒ absent (single-illuminant render profile).
    pub wb_frame_render_cm_cold: [f32; 9],
    pub wb_frame_render_cct_cold: f32,
    pub wb_frame_render_cm_warm: [f32; 9],
    pub wb_frame_render_cct_warm: f32,
    /// Render profile's FM pair (optional per side per the DNG spec).
    /// All-zero ⇒ that side's FM absent.
    pub wb_frame_render_fm_cold: [f32; 9],
    pub wb_frame_render_fm_warm: [f32; 9],
    // --- Black & white mix (#276) — the mode toggle plus 8 per-band
    //     luminance weights over the SAME hue bands as `hsl_*`. Appended at
    //     the struct tail per the offset-stable ABI convention: a stale host
    //     leaves `bw_active` at 0 ⇒ colour render, bit-identical output. ---
    /// 0 = colour (default), non-zero = black & white. Carried as f32 so the
    /// host marshalling stays a single float assignment like every other
    /// slider in this struct.
    pub bw_active: f32,
    pub bw_mix_red: f32,
    pub bw_mix_orange: f32,
    pub bw_mix_yellow: f32,
    pub bw_mix_green: f32,
    pub bw_mix_aqua: f32,
    pub bw_mix_blue: f32,
    pub bw_mix_purple: f32,
    pub bw_mix_magenta: f32,
    // --- colour grading (#275) — the rest of the Color Grading panel
    //     beyond the five `split_tone_*` sliders above (which are ACR's
    //     `crs:SplitToning*` shadow/highlight pairs and balance). Appended
    //     at the struct tail per the offset-stable ABI convention; a stale
    //     host leaves every field 0 = identity. ---
    pub color_grade_shadow_luminance: f32,
    pub color_grade_midtone_hue: f32,
    pub color_grade_midtone_saturation: f32,
    pub color_grade_midtone_luminance: f32,
    pub color_grade_highlight_luminance: f32,
    pub color_grade_global_hue: f32,
    pub color_grade_global_saturation: f32,
    pub color_grade_global_luminance: f32,
    // --- local adjustments (#1698) — the vector-mask layer stack, in the flat
    //     wire `raw_core::types::local_adjustment::flat` defines (24 f32 per
    //     layer, which is also the GPU storage layout, so nothing is re-packed
    //     between here and the bind group). Appended at the struct tail per the
    //     offset-stable ABI convention: a stale host leaves the pointer NULL
    //     and the length 0 ⇒ an empty stack ⇒ the pass is omitted and the
    //     output is bit-identical to pre-#1698. The pointed-to data must stay
    //     valid for the call; the Rust side copies it out and frees nothing. ---
    pub local_adjustments_ptr: *const f32,
    /// Number of f32 elements at `local_adjustments_ptr`. A multiple of 32; a
    /// trailing partial record is dropped rather than rejected.
    pub local_adjustments_len: usize,
    // --- DNG NoiseProfile + ISO (#1714) — the `RawImage::{noise_profile, iso}`
    //     pair the host already passes to the CPU chain via
    //     `MapleSceneLinearChainParams`. The NR stages scale `h` and the search
    //     radius PER PIXEL off these, so a GPU chain that can't see them
    //     denoises differently from the exported frame. Appended at the tail
    //     per the offset-stable ABI convention: null pointer / zero len ⇒ the
    //     flat filter, bit-identical to pre-#1714 output. ---
    /// Flat `(slope, offset)` pairs from the DNG NoiseProfile tag.
    pub noise_profile_ptr: *const f32,
    pub noise_profile_len: u32,
    /// `RawImage::iso`. Zero is raw-core's "unknown ISO" sentinel.
    pub iso: u32,
    // --- film look (epic #2683, Task 8) — display-linear, runs between
    //     color_grade and grain in the view tail (`raw_gpu::full_chain`'s
    //     module docs; `raw_core::stages::film_look::apply` is the CPU twin).
    //     Appended at the struct tail per the offset-stable ABI convention: a
    //     stale host leaves `film_lut_size` 0 and `film_lut_ptr` null, so the
    //     composition builder omits the pass entirely — bit-identical to
    //     pre-#2683 output. ---
    /// Blend strength, 0..100 nominal. `<= 0.0` is itself a no-op even with a
    /// grid loaded, mirroring every other blend-strength field in this struct.
    pub film_strength: f32,
    /// Film-look LUT node count per axis. `0` (paired with a null/empty
    /// `film_lut_ptr`) means "no look loaded".
    pub film_lut_size: u32,
    /// A content-identity key for the loaded film LUT (any host-stable u32 —
    /// Task 10 uses the FNV-1a hash of the look's catalog id string), NOT the
    /// grid data itself. `0` is reserved for "none"; this FFI layer does not
    /// interpret the value beyond folding it into the GPU chain signature.
    pub film_lut_key: u32,
    /// Flat film-look grid (`film_lut_size`³ × 3 floats, layout
    /// `((b*N+g)*N+r)*3+c` — the same layout [`crate::film::maple_film_lut_decode`]
    /// writes). Null / zero len = off (paired with `film_lut_size == 0`).
    pub film_lut_ptr: *const f32,
    pub film_lut_len: usize,
    // --- parametric tone-curve split points (#3152) — ACR's
    //     `crs:Parametric{Shadow,Midtone,Highlight}Split`, `[0, 100]`,
    //     default 25/50/75. Appended at the tail per the offset-stable ABI
    //     convention. UNLIKE most tail fields, `0.0` is NOT identity here (0
    //     is an in-range axis position, and the default is 25/50/75, not
    //     0/0/0) — `inputs_from_params` treats the WHOLE TRIPLE being 0.0 as
    //     "stale host" and substitutes the canonical defaults (a stale host
    //     always leaves every one of the three at the struct's zero
    //     default), the same fallback convention `noise_profile`/`iso`
    //     established in #2342. A live host that wants exactly
    //     `parametric_shadow_split == 0` can still express it, as long as
    //     the other two fields aren't also 0. ---
    pub parametric_shadow_split: f32,
    pub parametric_midtone_split: f32,
    pub parametric_highlight_split: f32,
    // --- display-referred (post-AgX) tone curves (#2232) —
    //     `crs:ToneCurvePV2012*`. Runs immediately after AgX, before
    //     color_grade, evaluating each channel independently in
    //     display-linear [0, 1] (no luma coupling — matches Lightroom's own
    //     per-channel point-curve application). Same flat `(x, y)` pair
    //     wire shape as `tone_curve_*_ptr` above. Appended at the struct
    //     tail per the offset-stable ABI convention: a stale host leaves
    //     every pointer null / len 0 ⇒ identity curves ⇒ the pass is
    //     omitted, bit-identical to pre-#2232 output. ---
    pub display_tone_curve_luma_ptr: *const f32,
    pub display_tone_curve_luma_len: usize,
    pub display_tone_curve_red_ptr: *const f32,
    pub display_tone_curve_red_len: usize,
    pub display_tone_curve_green_ptr: *const f32,
    pub display_tone_curve_green_len: usize,
    pub display_tone_curve_blue_ptr: *const f32,
    pub display_tone_curve_blue_len: usize,
    // --- Vectorscope scope statistics (#3272, spec §4/§5.4). Appended at the
    //     struct tail per the offset-stable ABI convention. `scope_layer` −1
    //     = no target (the scope weighs the whole frame); `scope_enabled`
    //     0 skips the pass entirely; `scope_out` null ⇒ never written. A
    //     zeroed tail (a stale host) reads as layer 0 + disabled + null:
    //     disabled wins, so the chain stays byte-identical to pre-#3272
    //     output and the pass is never even encoded. `scope_out`, once
    //     written, is one tick BEHIND the frame `maple_gpu_live_render` /
    //     `maple_gpu_present_chain` just produced — see
    //     `raw_gpu::LiveSession::take_scope_stats`. ---
    pub scope_layer: i32,
    pub scope_enabled: u8,
    pub scope_out: *mut crate::MapleScopeStats,
    /// Manual geometry in this session's display-oriented frame (#2435).
    pub geo_perspective_h: f32,
    pub geo_perspective_v: f32,
    pub geo_rotation: f32,
    pub geo_aspect: f32,
    pub geo_scale: f32,
}
