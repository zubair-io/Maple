//! Shared GPU prefix-model and chain-input assembly for native and browser hosts.
//! Moved from raw-wasm for #4317 without changing the adjustment mapping.
//! The stripped prefix retains upstream stages; raw-gpu owns the remaining chain.

use crate::xmp::AdjustmentModel;
use raw_gpu::{CurveMode, FullChainInputs, ToneCurveInputs};

/// Map a resolved raster list into raw-gpu's own carrier shape (#3271) —
/// `raw_gpu::GpuMaskRaster` can't be `crate::types::MaskRaster` directly;
/// see that type's doc for why (raw-gpu takes raw-core only as a
/// dev-dependency, so its real API can't name raw-core's type).
fn to_gpu_rasters(
    rasters: &[std::sync::Arc<crate::types::MaskRaster>],
    mut storage: Vec<raw_gpu::GpuMaskRaster>,
) -> Vec<raw_gpu::GpuMaskRaster> {
    storage.resize_with(rasters.len(), || raw_gpu::GpuMaskRaster {
        id: 0,
        width: 0,
        height: 0,
        data: Vec::new(),
    });
    for (target, source) in storage.iter_mut().zip(rasters) {
        target.id = source.id;
        target.width = source.width;
        target.height = source.height;
        target.data.clone_from(&source.data);
    }
    storage
}

#[derive(Default)]
struct InputStorage {
    curves: [Vec<(f32, f32)>; 8],
    layers: Vec<f32>,
    rasters: Vec<raw_gpu::GpuMaskRaster>,
}

pub use super::prefix::{prefix_matches, stripped_prefix_model};

/// The decoded frame's noise characterisation, carried from `RawImage` into the
/// GPU chain (#1714). The NR stages' per-pixel modulation is a function of these
/// two plus the pixel's own luminance, so the GPU chain has to see exactly what
/// `develop` hands `noise_reduction::apply_luminance` — otherwise the live
/// preview and the developed/exported frame denoise differently.
pub struct NoiseProfileInputs {
    /// `RawImage::noise_profile`, empty when the file carries none.
    pub profile: Vec<f32>,
    /// `RawImage::iso`.
    pub iso: u32,
}

/// Assemble the [`FullChainInputs`] the live chain consumes from the FULL user
/// model + the fitted Auto Profile artifacts. Mirrors `raw_gpu`'s `Case::gpu_inputs`
/// / the FFI `inputs_from_params` exactly: the WB matrix is derived from the
/// model's temp/tint via the SAME `wb_cat16_matrix` / `wb_gains` the CPU stage
/// uses, and `capture_sharpening` is `None` (baked in the develop prefix).
///
/// `film_lut` is the session-resident baked film-look grid (epic #2683, Task
/// 9) — NOT part of `AdjustmentModel`/XMP, since the `.mlut` bytes are a
/// runtime asset upload rather than sidecar state. `None` (paired with
/// `film_lut_key: 0`) folds to `film_lut_size: 0` / empty data, the
/// `FilmLutPass` "no look loaded" skip gate (`raw-gpu/src/full_chain.rs`).
/// `film_strength` DOES ride the model (`AdjustmentModel::film_strength`,
/// XMP `papp:FilmStrength`) since it round-trips through the sidecar like
/// every other slider.
pub fn build_full_chain_inputs(
    model: &AdjustmentModel,
    profile_curve_flat: Vec<f32>,
    residual_lut_size: usize,
    residual_lut_data: Vec<f32>,
    noise: NoiseProfileInputs,
    film_lut: Option<&crate::film::FilmLut>,
    film_lut_key: u32,
    whites_anchor_ev: f32,
) -> FullChainInputs<'static> {
    build_with_storage(
        model,
        profile_curve_flat,
        residual_lut_size,
        residual_lut_data,
        noise,
        film_lut,
        film_lut_key,
        whites_anchor_ev,
        Default::default(),
    )
}

fn reuse_points(mut storage: Vec<(f32, f32)>, points: &[(f32, f32)]) -> Vec<(f32, f32)> {
    storage.clear();
    storage.extend_from_slice(points);
    storage
}

fn build_with_storage(
    model: &AdjustmentModel,
    profile_curve_flat: Vec<f32>,
    residual_lut_size: usize,
    residual_lut_data: Vec<f32>,
    noise: NoiseProfileInputs,
    film_lut: Option<&crate::film::FilmLut>,
    film_lut_key: u32,
    whites_anchor_ev: f32,
    storage: InputStorage,
) -> FullChainInputs<'static> {
    let InputStorage {
        curves,
        mut layers,
        rasters,
    } = storage;
    let [luma, red, green, blue, display_luma, display_red, display_green, display_blue] = curves;
    crate::types::local_adjustment::flat::layers_to_flat_into(
        &model.local_adjustments,
        &mut layers,
    );
    use crate::types::WbMethod;

    let wb_matrix = match model.wb_method {
        WbMethod::Cat16 => {
            crate::stages::white_balance::wb_cat16_matrix(model.temperature, model.tint).0
        }
        WbMethod::DiagonalRec2020 => {
            let g = crate::stages::white_balance::wb_gains(model.temperature, model.tint);
            [[g[0], 0.0, 0.0], [0.0, g[1], 0.0], [0.0, 0.0, g[2]]]
        }
    };

    FullChainInputs {
        nr_sampling_scale: 1.0,
        whites_anchor_ev,
        wb_matrix,
        wb_temperature: model.temperature,
        wb_tint: model.tint,
        tone: [
            model.exposure,
            model.brightness,
            model.highlights,
            model.shadows,
            model.whites,
            model.blacks,
        ],
        tone_curves: ToneCurveInputs {
            parametric: [
                model.parametric_shadows,
                model.parametric_darks,
                model.parametric_lights,
                model.parametric_highlights,
            ],
            parametric_split: [
                model.parametric_shadow_split,
                model.parametric_midtone_split,
                model.parametric_highlight_split,
            ],
            luma: reuse_points(luma, &model.tone_curve_luma.points),
            red: reuse_points(red, &model.tone_curve_red.points),
            green: reuse_points(green, &model.tone_curve_green.points),
            blue: reuse_points(blue, &model.tone_curve_blue.points),
            mode: match model.tone_curve_mode {
                crate::types::ToneCurveMode::RatioPreserving => CurveMode::RatioPreserving,
                crate::types::ToneCurveMode::PerChannel => CurveMode::PerChannel,
            },
        },
        vibrance: model.vibrance,
        saturation: model.saturation,
        clarity: model.clarity,
        texture: model.texture,
        dehaze: model.dehaze,
        // Local adjustments (#1698) — serialized to the flat wire the GPU
        // storage buffer binds directly.
        local_adjustments: layers,
        // Every registered raster a `Mask::Bitmap` layer above may reference
        // (#3271), carried straight through from `model.mask_rasters` in
        // raw-gpu's own shape; see `to_gpu_rasters`. Always empty today — no
        // Web entry point registers a raster yet (`Mask::Bitmap` reaches the
        // model only via a sidecar written by another platform) — but the
        // plumbing is not Apple-specific, so a future Web raster source
        // needs no change here.
        mask_rasters: to_gpu_rasters(&model.mask_rasters, rasters),
        // No Web entry point drives the vectorscope scope pass yet (#3272 is
        // Apple-first) — always disabled here.
        scope: raw_gpu::ScopeRequest::default(),
        defringe: crate::stages::defringe::params_from_model(model)
            .map(|p| raw_gpu::DefringeInputs {
                // The GLOBAL controls claim no hue-agnostic strength — that
                // slot belongs to the per-mask control (#3407), which reaches
                // the same kernel through `LocalSpatialPass`.
                all_hues_strength: p.all_hues_strength,
                purple_strength: p.purple_strength,
                purple_lo: p.purple_lo,
                purple_hi: p.purple_hi,
                green_strength: p.green_strength,
                green_lo: p.green_lo,
                green_hi: p.green_hi,
            })
            .unwrap_or_default(),
        vignette_amount: model.vignette_amount,
        vignette_feather: model.vignette_feather,
        grain_amount: model.grain_amount,
        grain_size: model.grain_size,
        grain_roughness: model.grain_roughness,
        split_tone_shadow_hue: model.split_tone_shadow_hue,
        split_tone_shadow_saturation: model.split_tone_shadow_saturation,
        split_tone_highlight_hue: model.split_tone_highlight_hue,
        split_tone_highlight_saturation: model.split_tone_highlight_saturation,
        split_tone_balance: model.split_tone_balance,
        color_grade_shadow_luminance: model.color_grade_shadow_luminance,
        color_grade_midtone_hue: model.color_grade_midtone_hue,
        color_grade_midtone_saturation: model.color_grade_midtone_saturation,
        color_grade_midtone_luminance: model.color_grade_midtone_luminance,
        color_grade_highlight_luminance: model.color_grade_highlight_luminance,
        color_grade_global_hue: model.color_grade_global_hue,
        color_grade_global_saturation: model.color_grade_global_saturation,
        color_grade_global_luminance: model.color_grade_global_luminance,
        hsl_hue: [
            model.hue_adjustment_red,
            model.hue_adjustment_orange,
            model.hue_adjustment_yellow,
            model.hue_adjustment_green,
            model.hue_adjustment_aqua,
            model.hue_adjustment_blue,
            model.hue_adjustment_purple,
            model.hue_adjustment_magenta,
        ],
        hsl_sat: [
            model.saturation_adjustment_red,
            model.saturation_adjustment_orange,
            model.saturation_adjustment_yellow,
            model.saturation_adjustment_green,
            model.saturation_adjustment_aqua,
            model.saturation_adjustment_blue,
            model.saturation_adjustment_purple,
            model.saturation_adjustment_magenta,
        ],
        hsl_lum: [
            model.luminance_adjustment_red,
            model.luminance_adjustment_orange,
            model.luminance_adjustment_yellow,
            model.luminance_adjustment_green,
            model.luminance_adjustment_aqua,
            model.luminance_adjustment_blue,
            model.luminance_adjustment_purple,
            model.luminance_adjustment_magenta,
        ],
        // Black & white mix (#276) — same band order as the three HSL
        // groups above. Omitting these would leave the web GPU live path
        // rendering in colour while the CPU refine pass rendered mono.
        bw_mix: [
            model.gray_mixer_red,
            model.gray_mixer_orange,
            model.gray_mixer_yellow,
            model.gray_mixer_green,
            model.gray_mixer_aqua,
            model.gray_mixer_blue,
            model.gray_mixer_purple,
            model.gray_mixer_magenta,
        ],
        bw_active: model.black_white == crate::types::BlackWhiteMode::On,
        sharpen_amount: model.sharpen_amount,
        sharpen_radius: model.sharpen_radius,
        sharpen_detail: model.sharpen_detail,
        sharpen_masking: model.sharpen_masking,
        nr_luminance: model.nr_luminance,
        nr_color: model.nr_color,
        contrast: model.contrast,
        // Baked into the develop prefix (`capture_sharpening` runs at its
        // canonical 04b position there) → omit on the GPU chain to avoid a
        // double-apply, mirroring the Apple decode-boundary contract.
        capture_sharpening: None,
        profile_curve_flat: profile_curve_flat.into(),
        residual_lut_size,
        residual_lut_data: residual_lut_data.into(),
        // Web does not yet surface a P3-canvas path (canvas is tagged
        // display-P3 but the live render target is managed by the browser).
        // Legacy sRGB encode (0) is bit-identical to pre-#1337 behavior.
        target_primaries: 0,
        // Web always decodes RAW and routes through the full chain.
        input_shape: raw_gpu::InputShape::PostDcpRec2020Fp16,
        // The decoded frame's noise characterisation (#1714) — the same pair
        // `develop` passes to the CPU NR stages, so the GPU chain's per-pixel
        // modulation matches the developed/exported frame.
        noise_profile: noise.profile,
        iso: noise.iso,
        // Film emulation (epic #2683, Task 9) — see this fn's doc for the
        // model-vs-session-state split. `film_lut_size == 0` (the `None` /
        // empty-grid case) is the composition builder's skip gate; the key is
        // 0 alongside it so a no-look chain never carries a stale identity.
        film_strength: model.film_strength,
        film_lut_size: film_lut.map(|l| l.size as u32).unwrap_or(0),
        film_lut_key: if film_lut.is_some() { film_lut_key } else { 0 },
        film_lut_data: film_lut.map(|l| l.data.clone()).unwrap_or_default().into(),
        // Display-referred point curves (#2232, `crs:ToneCurvePV2012*`) —
        // same flat-point shape as `tone_curves` above.
        display_tone_curves: raw_gpu::DisplayToneCurveInputs {
            master: reuse_points(display_luma, &model.display_tone_curve_luma.points),
            red: reuse_points(display_red, &model.display_tone_curve_red.points),
            green: reuse_points(display_green, &model.display_tone_curve_green.points),
            blue: reuse_points(display_blue, &model.display_tone_curve_blue.points),
        },
    }
}

/// Refresh adjustment mapping while retaining image-owned Auto fit/noise buffers.
/// Profile changes require a fresh `chain_inputs_with_status` at session preparation.
/// Curve, layer and raster storage is reused while capacity permits (#4317).
/// The rebuilt WB matrix is the unanchored one: callers re-apply
/// `GpuWhiteBalance::apply` afterwards for the camera-frame delta.
pub fn update_chain_inputs(model: &AdjustmentModel, inputs: &mut FullChainInputs<'static>) {
    let curve = std::mem::take(&mut inputs.profile_curve_flat).into_owned();
    let lut = std::mem::take(&mut inputs.residual_lut_data).into_owned();
    let noise = std::mem::take(&mut inputs.noise_profile);
    let mut replacement = build_with_storage(
        model,
        curve,
        inputs.residual_lut_size,
        lut,
        NoiseProfileInputs {
            profile: noise,
            iso: inputs.iso,
        },
        None,
        0,
        inputs.whites_anchor_ev,
        InputStorage {
            curves: [
                std::mem::take(&mut inputs.tone_curves.luma),
                std::mem::take(&mut inputs.tone_curves.red),
                std::mem::take(&mut inputs.tone_curves.green),
                std::mem::take(&mut inputs.tone_curves.blue),
                std::mem::take(&mut inputs.display_tone_curves.master),
                std::mem::take(&mut inputs.display_tone_curves.red),
                std::mem::take(&mut inputs.display_tone_curves.green),
                std::mem::take(&mut inputs.display_tone_curves.blue),
            ],
            layers: std::mem::take(&mut inputs.local_adjustments),
            rasters: std::mem::take(&mut inputs.mask_rasters),
        },
    );
    replacement.film_lut_size = inputs.film_lut_size;
    replacement.film_lut_key = inputs.film_lut_key;
    replacement.film_lut_data = std::mem::take(&mut inputs.film_lut_data);
    replacement.target_primaries = inputs.target_primaries;
    replacement.input_shape = inputs.input_shape;
    replacement.nr_sampling_scale = inputs.nr_sampling_scale;
    replacement.scope = inputs.scope;
    *inputs = replacement;
}
