use crate::color_curves::{ColorCurveInputs, ColorCurvePoints};
use crate::full_chain::FullChainInputs;
use crate::tone_curves::ToneCurveInputs;
use crate::{CaptureSharpeningParams, CreativeInputs, CreativeTable, DefringeInputs};
use crate::{GpuMaskRaster, ScopeRequest};

#[derive(Default)]
pub(crate) struct PrefixKey {
    words: Vec<u32>,
}

impl PrefixKey {
    pub(crate) fn update(&mut self, inputs: &FullChainInputs<'_>) -> bool {
        let mut writer = KeyWriter {
            words: &mut self.words,
            position: 0,
            same: true,
        };
        write_prefix(inputs, &mut writer);
        writer.finish()
    }

    pub(crate) fn clear(&mut self) {
        self.words.clear();
    }
}

struct KeyWriter<'a> {
    words: &'a mut Vec<u32>,
    position: usize,
    same: bool,
}

impl KeyWriter<'_> {
    fn slice(&mut self, words: &[u32]) {
        if self.same {
            let end = self.position + words.len();
            if self.words.get(self.position..end) == Some(words) {
                self.position = end;
                return;
            }
            self.words.truncate(self.position);
            self.same = false;
        }
        self.words.extend_from_slice(words);
    }

    fn u(&mut self, value: u32) {
        self.slice(&[value]);
    }

    fn len(&mut self, len: usize) {
        let len = len as u64;
        self.slice(&[len as u32, (len >> 32) as u32]);
    }

    fn f(&mut self, value: f32) {
        self.u(value.to_bits());
    }

    fn floats(&mut self, values: &[f32]) {
        self.len(values.len());
        self.slice(bytemuck::cast_slice(values));
    }

    fn points(&mut self, points: &[(f32, f32)]) {
        self.len(points.len());
        for &(x, y) in points {
            self.slice(&[x.to_bits(), y.to_bits()]);
        }
    }

    fn finish(self) -> bool {
        if !self.same {
            return false;
        }
        let same = self.position == self.words.len();
        self.words.truncate(self.position);
        same
    }
}

// Read only after the cut; the exhaustive destructure keeps a new field from compiling unclassified.
macro_rules! view_tail_fields {
    ($($field:ident),* $(,)?) => {
        #[cfg(test)]
        pub(crate) const VIEW_TAIL_FIELDS: &[&str] = &[$(stringify!($field)),*];

        fn write_prefix(inputs: &FullChainInputs<'_>, w: &mut KeyWriter<'_>) {
            let FullChainInputs {
                $($field: _,)*
                wb_matrix,
                wb_temperature,
                wb_tint,
                tone,
                tone_curves,
                vibrance,
                saturation,
                hsl_hue,
                hsl_sat,
                hsl_lum,
                bw_mix,
                bw_active,
                clarity,
                texture,
                dehaze,
                local_adjustments,
                vignette_amount,
                vignette_feather,
                sharpen_amount,
                sharpen_radius,
                sharpen_detail,
                sharpen_masking,
                nr_luminance,
                nr_color,
                nr_sampling_scale,
                capture_sharpening,
                input_shape,
                noise_profile,
                iso,
                mask_rasters,
                scope,
                defringe,
                mask_orientation,
                color_curves,
                creative,
            } = inputs;
            wb_matrix.iter().flatten().for_each(|&v| w.f(v));
            [*wb_temperature, *wb_tint].into_iter().for_each(|v| w.f(v));
            // tone[4] is Whites, read only by the view transform.
            [tone[0], tone[1], tone[2], tone[3], tone[5]]
                .into_iter()
                .for_each(|v| w.f(v));
            write_tone_curves(tone_curves, w);
            [*vibrance, *saturation].into_iter().for_each(|v| w.f(v));
            [hsl_hue, hsl_sat, hsl_lum, bw_mix]
                .into_iter()
                .for_each(|band| band.iter().for_each(|&v| w.f(v)));
            w.u(u32::from(*bw_active));
            [*clarity, *texture, *dehaze]
                .into_iter()
                .for_each(|v| w.f(v));
            w.floats(local_adjustments);
            [*vignette_amount, *vignette_feather]
                .into_iter()
                .for_each(|v| w.f(v));
            [
                *sharpen_amount,
                *sharpen_radius,
                *sharpen_detail,
                *sharpen_masking,
                *nr_luminance,
                *nr_color,
                *nr_sampling_scale,
            ]
            .into_iter()
            .for_each(|v| w.f(v));
            write_capture_sharpening(capture_sharpening.as_ref(), w);
            w.u(*input_shape as u32);
            w.floats(noise_profile);
            w.u(*iso);
            w.len(mask_rasters.len());
            mask_rasters
                .iter()
                .for_each(|raster| write_raster(raster, w));
            let ScopeRequest { layer, enabled } = scope;
            w.u(*layer as u32);
            w.u(u32::from(*enabled));
            write_defringe(defringe, w);
            w.u(*mask_orientation);
            write_color_curves(color_curves, w);
            write_creative(creative.as_ref(), w);
        }
    };
}

view_tail_fields! {
    whites_anchor_ev,
    contrast,
    grain_amount,
    grain_size,
    grain_roughness,
    split_tone_shadow_hue,
    split_tone_shadow_saturation,
    split_tone_highlight_hue,
    split_tone_highlight_saturation,
    split_tone_balance,
    color_grade_shadow_luminance,
    color_grade_midtone_hue,
    color_grade_midtone_saturation,
    color_grade_midtone_luminance,
    color_grade_highlight_luminance,
    color_grade_global_hue,
    color_grade_global_saturation,
    color_grade_global_luminance,
    color_grade_blending,
    color_grade_shadow_edge,
    color_grade_highlight_edge,
    film_strength,
    film_lut_size,
    film_lut_key,
    film_lut_data,
    display_tone_curves,
    profile_curve_flat,
    residual_lut_size,
    residual_lut_data,
    target_primaries,
}

fn write_tone_curves(curves: &ToneCurveInputs, w: &mut KeyWriter<'_>) {
    let ToneCurveInputs {
        parametric,
        parametric_split,
        luma,
        red,
        green,
        blue,
        mode,
    } = curves;
    parametric
        .iter()
        .chain(parametric_split)
        .for_each(|&v| w.f(v));
    [luma, red, green, blue]
        .into_iter()
        .for_each(|points| w.points(points));
    w.u(*mode as u32);
}

fn write_capture_sharpening(params: Option<&CaptureSharpeningParams>, w: &mut KeyWriter<'_>) {
    let Some(CaptureSharpeningParams {
        sigma,
        iterations,
        highlight_threshold,
        strength,
        noise_floor,
    }) = params
    else {
        return w.u(0);
    };
    w.u(1);
    w.u(*iterations);
    [*sigma, *highlight_threshold, *strength, *noise_floor]
        .into_iter()
        .for_each(|v| w.f(v));
}

fn write_raster(raster: &GpuMaskRaster, w: &mut KeyWriter<'_>) {
    let GpuMaskRaster {
        id,
        width,
        height,
        data,
    } = raster;
    [*id, *width, *height].into_iter().for_each(|v| w.u(v));
    w.floats(data);
}

fn write_defringe(defringe: &DefringeInputs, w: &mut KeyWriter<'_>) {
    let DefringeInputs {
        all_hues_strength,
        purple_strength,
        purple_lo,
        purple_hi,
        green_strength,
        green_lo,
        green_hi,
    } = defringe;
    [
        *all_hues_strength,
        *purple_strength,
        *purple_lo,
        *purple_hi,
        *green_strength,
        *green_lo,
        *green_hi,
    ]
    .into_iter()
    .for_each(|v| w.f(v));
}

fn write_color_curves(curves: &ColorCurveInputs<'_>, w: &mut KeyWriter<'_>) {
    let ColorCurveInputs {
        hue_vs_hue,
        hue_vs_sat,
        hue_vs_luma,
        luma_vs_sat,
        sat_vs_sat,
        sat_vs_luma,
    } = curves;
    for curve in [
        hue_vs_hue,
        hue_vs_sat,
        hue_vs_luma,
        luma_vs_sat,
        sat_vs_sat,
        sat_vs_luma,
    ] {
        match curve {
            ColorCurvePoints::Owned(points) => {
                w.u(0);
                w.points(points);
            }
            ColorCurvePoints::Flat(flat) => {
                w.u(1);
                w.floats(flat);
            }
        }
    }
}

fn write_creative(creative: Option<&CreativeInputs<'_>>, w: &mut KeyWriter<'_>) {
    let Some(CreativeInputs {
        to_pro,
        from_pro,
        tables,
        hsm,
        look,
        highlight_recovery,
        post,
    }) = creative
    else {
        return w.u(0);
    };
    w.u(1);
    [to_pro, from_pro, post]
        .into_iter()
        .for_each(|m| m.iter().flatten().for_each(|&v| w.f(v)));
    w.floats(tables);
    [hsm, look]
        .into_iter()
        .for_each(|table| write_creative_table(table.as_ref(), w));
    w.u(u32::from(*highlight_recovery));
}

fn write_creative_table(table: Option<&CreativeTable>, w: &mut KeyWriter<'_>) {
    let Some(CreativeTable {
        dims,
        srgb,
        cold_offset,
        warm_offset,
        warm_weight,
    }) = table
    else {
        return w.u(0);
    };
    w.u(1);
    dims.iter().for_each(|&v| w.u(v));
    w.u(u32::from(*srgb));
    w.len(*cold_offset);
    w.u(u32::from(warm_offset.is_some()));
    w.len(warm_offset.unwrap_or(0));
    w.f(*warm_weight);
}
