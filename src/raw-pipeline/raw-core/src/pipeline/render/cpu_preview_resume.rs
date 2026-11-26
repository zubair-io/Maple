use crate::{image::Image, xmp::AdjustmentModel};

// A 3:2 preview reaches this at about 3547×2365; the 4096 px wasm develop ceiling (134 MB) is never kept.
pub(super) const MAX_KEPT_BYTES: usize = 96 << 20;

// The first repeat is as likely one edit landing as a drag; the second pays for the copy.
const KEEP_FROM_REPEAT: u32 = 2;

pub(super) type DetailAmounts = [u32; 3];

macro_rules! classify_model {
    (
        detail: [$($detail:ident),* $(,)?],
        view_tail: [$($tail:ident),* $(,)?],
        upstream: [$($upstream:ident),* $(,)?] $(,)?
    ) => {
        #[cfg(test)]
        pub(super) const VIEW_TAIL_FIELDS: &[&str] = &[$(stringify!($tail)),*];

        pub(super) fn detail_amounts(model: &AdjustmentModel) -> DetailAmounts {
            [$(model.$detail),*].map(f32::to_bits)
        }

        // A field in no list fails to compile; one listed `upstream` rebuilds, so it cannot go stale.
        #[allow(deprecated)]
        pub(super) fn exchange_late_inputs(
            model: AdjustmentModel,
            other: AdjustmentModel,
        ) -> (AdjustmentModel, AdjustmentModel) {
            let AdjustmentModel { $($detail,)* $($tail,)* $($upstream,)* } = model;
            let exchanged = AdjustmentModel {
                $($detail: other.$detail,)*
                $($tail: other.$tail,)*
                $($upstream,)*
            };
            (exchanged, AdjustmentModel { $($detail,)* $($tail,)* ..other })
        }
    };
}

classify_model! {
    detail: [sharpen_amount, nr_luminance, nr_color],
    view_tail: [
        contrast, whites, grain_amount, grain_size, grain_roughness, film_look,
        film_strength, split_tone_shadow_hue, split_tone_shadow_saturation,
        split_tone_highlight_hue, split_tone_highlight_saturation, split_tone_balance,
        color_grade_shadow_luminance, color_grade_midtone_hue,
        color_grade_midtone_saturation, color_grade_midtone_luminance,
        color_grade_highlight_luminance, color_grade_global_hue,
        color_grade_global_saturation, color_grade_global_luminance,
        display_tone_curve_luma, display_tone_curve_red, display_tone_curve_green,
        display_tone_curve_blue, color_grade_blending, color_grade_shadow_edge,
        color_grade_highlight_edge,
    ],
    upstream: [
        temperature, tint, temperature_seen, tint_seen, unresolved_auto_wb, wb_method,
        wb_scale_version, wb_source, wb_sample_x, wb_sample_y, wb_algorithm_version,
        exposure, brightness, highlights, shadows, blacks, parametric_highlights,
        parametric_lights, parametric_darks, parametric_shadows,
        parametric_shadow_split, parametric_midtone_split, parametric_highlight_split,
        vibrance, saturation, clarity, texture, sharpen_radius, sharpen_detail,
        sharpen_masking, capture_sharpening_amount, capture_sharpening_sigma,
        capture_sharpening_radius, dehaze, vignette_amount, vignette_feather,
        hue_adjustment_red, hue_adjustment_orange, hue_adjustment_yellow,
        hue_adjustment_green, hue_adjustment_aqua, hue_adjustment_blue,
        hue_adjustment_purple, hue_adjustment_magenta, saturation_adjustment_red,
        saturation_adjustment_orange, saturation_adjustment_yellow,
        saturation_adjustment_green, saturation_adjustment_aqua,
        saturation_adjustment_blue, saturation_adjustment_purple,
        saturation_adjustment_magenta, luminance_adjustment_red,
        luminance_adjustment_orange, luminance_adjustment_yellow,
        luminance_adjustment_green, luminance_adjustment_aqua,
        luminance_adjustment_blue, luminance_adjustment_purple,
        luminance_adjustment_magenta, black_white, gray_mixer_red, gray_mixer_orange,
        gray_mixer_yellow, gray_mixer_green, gray_mixer_aqua, gray_mixer_blue,
        gray_mixer_purple, gray_mixer_magenta, highlight_recovery, auto_exposure, look,
        profile, local_adjustments, mask_rasters, inpaint_removals, retouch_spots,
        retouch_frame, tone_curve_mode, tone_curve_luma, tone_curve_red,
        tone_curve_green, tone_curve_blue, chroma_prefilter, hot_pixel_suppression,
        deep_denoise, crop, lens_profile_enable, lens_correction_distortion,
        lens_correction_ca, lens_correction_vignetting, perspective_vertical,
        perspective_horizontal, perspective_rotate, perspective_scale,
        perspective_aspect, perspective_x, perspective_y, demosaic, auto_lateral_ca,
        defringe_purple_amount, defringe_purple_hue_lo, defringe_purple_hue_hi,
        defringe_green_amount, defringe_green_hue_lo, defringe_green_hue_hi,
        lens_profile, color_curve_hue_vs_hue, color_curve_hue_vs_sat,
        color_curve_hue_vs_luma, color_curve_luma_vs_sat, color_curve_sat_vs_sat,
        color_curve_sat_vs_luma,
    ],
}

pub(super) fn develop_key(model: AdjustmentModel) -> AdjustmentModel {
    exchange_late_inputs(model, AdjustmentModel::default()).0
}

pub(super) fn restore(working: &mut Image, from: &Image) {
    working.pixels.copy_from_slice(&from.pixels);
    working.space = from.space;
    working.whites_anchor_ev = from.whites_anchor_ev;
    working.nr_sampling_scale = from.nr_sampling_scale;
}

pub(super) enum DetailPlan<'a> {
    Resume(&'a Image),
    Run { keep: bool },
}

#[derive(Default)]
pub(super) struct DetailedScene {
    amounts: Option<DetailAmounts>,
    repeats: u32,
    kept: Option<Image>,
}

impl DetailedScene {
    pub(super) fn opened(amounts: DetailAmounts) -> Self {
        Self {
            amounts: Some(amounts),
            ..Self::default()
        }
    }

    pub(super) fn plan(&mut self, amounts: DetailAmounts, scene_bytes: usize) -> DetailPlan<'_> {
        if self.amounts != Some(amounts) {
            *self = Self::opened(amounts);
        } else if self.kept.is_none() {
            self.repeats = self.repeats.saturating_add(1);
        }
        match &self.kept {
            Some(kept) => DetailPlan::Resume(kept),
            // With every amount at zero the detail stages change nothing: the prefix already is this scene.
            None => DetailPlan::Run {
                keep: self.repeats >= KEEP_FROM_REPEAT
                    && amounts.iter().any(|&bits| f32::from_bits(bits) != 0.0)
                    && scene_bytes <= MAX_KEPT_BYTES,
            },
        }
    }

    pub(super) fn keep(&mut self, scene: &Image) {
        let mut pixels = Vec::new();
        if !reserve(&mut pixels, scene.pixels.len()) {
            return;
        }
        pixels.extend_from_slice(&scene.pixels);
        self.kept = Some(Image { pixels, ..*scene });
    }

    #[cfg(test)]
    pub(super) fn kept(&self) -> Option<&Image> {
        self.kept.as_ref()
    }
}

#[cfg(test)]
thread_local! {
    pub(super) static REFUSE_RESERVATIONS: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

// An allocation failure aborts the wasm instance, so the copy is only made when the reservation succeeds.
fn reserve(pixels: &mut Vec<[f32; 3]>, len: usize) -> bool {
    #[cfg(test)]
    if REFUSE_RESERVATIONS.with(std::cell::Cell::get) {
        return false;
    }
    pixels.try_reserve_exact(len).is_ok()
}
