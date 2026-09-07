//! ABI-layout export for the hand-mirrored C# structs (#3221).
//!
//! `src/windows/Maple.WinUI/Native/*.cs` re-declares every `#[repr(C)]`
//! struct the WinUI shell passes across `raw_ffi.dll` field by field, in
//! declaration order, and nothing checked that the two agreed: the
//! `MapleGpuLiveParams` mirror was missing #2683's film-look tail for a
//! month (the Rust side read those fields past the end of the C#
//! allocation), and `MapleSceneLinearBufferF32` was missing #2231's two
//! trailing `u32`s. [`maple_abi_layout`] lets the WinUI test suite
//! (`RawFfiLayoutTests`) ask the DLL it will actually load for the size and
//! every field offset of each mirrored struct — computed here with
//! `core::mem::offset_of!` from the real definitions, never re-typed — and
//! assert `Marshal.SizeOf` / `Marshal.OffsetOf` against them, field name by
//! field name, in the existing `windows-x64` job.
//!
//! Wire format (UTF-8, no trailing NUL): `size=<bytes>;<field>=<offset>;…`
//! with the fields in declaration order, so the consumer can also check
//! that its own field ORDER matches, not just the offsets.
//!
//! Adding a field to one of these structs: append it to the matching list
//! below. Forgetting to does not hide drift — `size=` still moves, and the
//! C# side also fails when a mirror field has no Rust entry.

use core::mem::{offset_of, size_of};
use std::ffi::CStr;
use std::os::raw::c_char;

/// `size=N;field=off;…` for one struct. Each field name is spelled once,
/// and `offset_of!` refuses to compile for a name that is not a field.
macro_rules! layout {
    ($ty:path { $($field:ident),* $(,)? }) => {{
        let mut out = format!("size={}", size_of::<$ty>());
        $(
            out.push_str(&format!(";{}={}", stringify!($field), offset_of!($ty, $field)));
        )*
        out
    }};
}

/// The layout description for `name`, or `None` for a struct this crate
/// does not export a layout for (including the GPU-gated ones in a build
/// without the `gpu` feature).
pub(crate) fn describe(name: &str) -> Option<String> {
    match name {
        "MapleAdjustmentParams" => {
            Some(layout!(crate::scene_linear_chain::MapleAdjustmentParams {
                temperature,
                tint,
                exposure,
                contrast,
                highlights,
                shadows,
                whites,
                blacks,
                vibrance,
                saturation,
                clarity,
                texture,
                nr_luminance,
                dehaze,
                decoded_temperature,
                decoded_tint,
                skip_agx,
                look_mode,
                brightness,
                vignette_amount,
                vignette_feather,
                grain_amount,
                grain_size,
                grain_roughness,
                split_tone_shadow_hue,
                split_tone_shadow_saturation,
                split_tone_highlight_hue,
                split_tone_highlight_saturation,
                split_tone_balance,
                hsl_hue_red,
                hsl_hue_orange,
                hsl_hue_yellow,
                hsl_hue_green,
                hsl_hue_aqua,
                hsl_hue_blue,
                hsl_hue_purple,
                hsl_hue_magenta,
                hsl_sat_red,
                hsl_sat_orange,
                hsl_sat_yellow,
                hsl_sat_green,
                hsl_sat_aqua,
                hsl_sat_blue,
                hsl_sat_purple,
                hsl_sat_magenta,
                hsl_lum_red,
                hsl_lum_orange,
                hsl_lum_yellow,
                hsl_lum_green,
                hsl_lum_aqua,
                hsl_lum_blue,
                hsl_lum_purple,
                hsl_lum_magenta,
                target_primaries,
                input_shape,
                noise_profile_ptr,
                noise_profile_len,
                iso,
                wb_frame_m_cold,
                wb_frame_cct_cold,
                wb_frame_m_warm,
                wb_frame_cct_warm,
                wb_frame_scene_cct,
                wb_frame_as_shot_tint,
                wb_frame_render_cm,
                wb_frame_render_forward_matrix,
                wb_frame_render_scene_white_xyz,
                wb_frame_render_wb_already_baked,
                wb_frame_render_cm_cold,
                wb_frame_render_cct_cold,
                wb_frame_render_cm_warm,
                wb_frame_render_cct_warm,
                wb_frame_render_fm_cold,
                wb_frame_render_fm_warm,
                bw_active,
                bw_mix_red,
                bw_mix_orange,
                bw_mix_yellow,
                bw_mix_green,
                bw_mix_aqua,
                bw_mix_blue,
                bw_mix_purple,
                bw_mix_magenta,
                color_grade_shadow_luminance,
                color_grade_midtone_hue,
                color_grade_midtone_saturation,
                color_grade_midtone_luminance,
                color_grade_highlight_luminance,
                color_grade_global_hue,
                color_grade_global_saturation,
                color_grade_global_luminance,
                sharpen_amount,
                sharpen_radius,
                sharpen_detail,
                sharpen_masking,
                nr_color,
                local_adjustments_ptr,
                local_adjustments_len,
            }))
        }
        "MapleToneCurves" => Some(layout!(crate::scene_linear_chain_curves::MapleToneCurves {
            luma_ptr,
            luma_len,
            red_ptr,
            red_len,
            green_ptr,
            green_len,
            blue_ptr,
            blue_len,
            mode,
            display_luma_ptr,
            display_luma_len,
            display_red_ptr,
            display_red_len,
            display_green_ptr,
            display_green_len,
            display_blue_ptr,
            display_blue_len,
        })),
        "MapleSceneLinearBufferF32" => Some(layout!(crate::buffers::MapleSceneLinearBufferF32 {
            f32_rgba,
            len_bytes,
            channels,
            bytes_per_pixel,
            width,
            height,
            noise_profile_data,
            noise_profile_len,
            iso,
            wb_frame_m_cold,
            wb_frame_cct_cold,
            wb_frame_m_warm,
            wb_frame_cct_warm,
            wb_frame_scene_cct,
            wb_frame_as_shot_tint,
            wb_frame_render_cm,
            wb_frame_render_forward_matrix,
            wb_frame_render_scene_white_xyz,
            wb_frame_render_wb_already_baked,
            wb_frame_render_cm_cold,
            wb_frame_render_cct_cold,
            wb_frame_render_cm_warm,
            wb_frame_render_cct_warm,
            wb_frame_render_fm_cold,
            wb_frame_render_fm_warm,
            ae_gain,
            has_lens_corrections,
            lens_correction_ca_inert,
            lens_correction_distortion_inert,
        })),
        "MapleAutoAdjustments" => Some(layout!(crate::auto_adjustments::MapleAutoAdjustments {
            exposure,
            temperature,
            tint,
            contrast,
            highlights,
            shadows,
            whites,
            blacks,
        })),
        #[cfg(feature = "gpu")]
        "MapleGpuLiveParams" => Some(layout!(crate::gpu_live::MapleGpuLiveParams {
            temperature,
            tint,
            wb_method,
            exposure,
            highlights,
            shadows,
            whites,
            blacks,
            contrast,
            parametric_shadows,
            parametric_darks,
            parametric_lights,
            parametric_highlights,
            tone_curve_mode,
            vibrance,
            saturation,
            clarity,
            texture,
            dehaze,
            sharpen_amount,
            sharpen_radius,
            sharpen_detail,
            sharpen_masking,
            nr_luminance,
            nr_color,
            capture_sharpening_enabled,
            capture_sharpening_sigma,
            capture_sharpening_iterations,
            capture_sharpening_highlight_threshold,
            capture_sharpening_strength,
            tone_curve_luma_ptr,
            tone_curve_luma_len,
            tone_curve_red_ptr,
            tone_curve_red_len,
            tone_curve_green_ptr,
            tone_curve_green_len,
            tone_curve_blue_ptr,
            tone_curve_blue_len,
            profile_curve_ptr,
            profile_curve_len,
            residual_lut_size,
            residual_lut_ptr,
            residual_lut_len,
            brightness,
            vignette_amount,
            vignette_feather,
            grain_amount,
            grain_size,
            grain_roughness,
            split_tone_shadow_hue,
            split_tone_shadow_saturation,
            split_tone_highlight_hue,
            split_tone_highlight_saturation,
            split_tone_balance,
            hsl_hue_red,
            hsl_hue_orange,
            hsl_hue_yellow,
            hsl_hue_green,
            hsl_hue_aqua,
            hsl_hue_blue,
            hsl_hue_purple,
            hsl_hue_magenta,
            hsl_sat_red,
            hsl_sat_orange,
            hsl_sat_yellow,
            hsl_sat_green,
            hsl_sat_aqua,
            hsl_sat_blue,
            hsl_sat_purple,
            hsl_sat_magenta,
            hsl_lum_red,
            hsl_lum_orange,
            hsl_lum_yellow,
            hsl_lum_green,
            hsl_lum_aqua,
            hsl_lum_blue,
            hsl_lum_purple,
            hsl_lum_magenta,
            decoded_temperature,
            decoded_tint,
            target_primaries,
            input_shape,
            wb_frame_m_cold,
            wb_frame_cct_cold,
            wb_frame_m_warm,
            wb_frame_cct_warm,
            wb_frame_scene_cct,
            wb_frame_as_shot_tint,
            wb_frame_render_cm,
            wb_frame_render_forward_matrix,
            wb_frame_render_scene_white_xyz,
            wb_frame_render_wb_already_baked,
            wb_frame_render_cm_cold,
            wb_frame_render_cct_cold,
            wb_frame_render_cm_warm,
            wb_frame_render_cct_warm,
            wb_frame_render_fm_cold,
            wb_frame_render_fm_warm,
            bw_active,
            bw_mix_red,
            bw_mix_orange,
            bw_mix_yellow,
            bw_mix_green,
            bw_mix_aqua,
            bw_mix_blue,
            bw_mix_purple,
            bw_mix_magenta,
            color_grade_shadow_luminance,
            color_grade_midtone_hue,
            color_grade_midtone_saturation,
            color_grade_midtone_luminance,
            color_grade_highlight_luminance,
            color_grade_global_hue,
            color_grade_global_saturation,
            color_grade_global_luminance,
            local_adjustments_ptr,
            local_adjustments_len,
            noise_profile_ptr,
            noise_profile_len,
            iso,
            film_strength,
            film_lut_size,
            film_lut_key,
            film_lut_ptr,
            film_lut_len,
            parametric_shadow_split,
            parametric_midtone_split,
            parametric_highlight_split,
            display_tone_curve_luma_ptr,
            display_tone_curve_luma_len,
            display_tone_curve_red_ptr,
            display_tone_curve_red_len,
            display_tone_curve_green_ptr,
            display_tone_curve_green_len,
            display_tone_curve_blue_ptr,
            display_tone_curve_blue_len,
            scope_layer,
            scope_enabled,
            scope_out,
            geo_perspective_h,
            geo_perspective_v,
            geo_rotation,
            geo_aspect,
            geo_scale,
        })),
        #[cfg(feature = "gpu")]
        "MapleGpuLiveSession" => Some(layout!(crate::gpu_live::MapleGpuLiveSession { inner })),
        _ => None,
    }
}

/// Write the layout description of the `#[repr(C)]` struct named
/// `struct_name` (e.g. `"MapleGpuLiveParams"`) into the caller-owned
/// `out_buf` (UTF-8, NOT NUL-terminated) and its byte length into
/// `out_len`.
///
/// Returns 0 on success; 1 when `struct_name` is not a struct this build
/// exports a layout for (`out_len` is set to 0); 2 when `out_cap` is too
/// small (`out_len` carries the required length, `out_buf` is untouched);
/// -1 when `struct_name`, `out_buf` or `out_len` is null or `struct_name`
/// is not valid UTF-8. 4 KiB is ample for every struct today.
///
/// # Safety
/// `struct_name` must be a NUL-terminated string; `out_buf` must be valid
/// for `out_cap` writes; `out_len` must be valid for one write.
#[no_mangle]
pub unsafe extern "C" fn maple_abi_layout(
    struct_name: *const c_char,
    out_buf: *mut u8,
    out_cap: usize,
    out_len: *mut usize,
) -> i32 {
    if struct_name.is_null() || out_buf.is_null() || out_len.is_null() {
        return -1;
    }
    let Ok(name) = CStr::from_ptr(struct_name).to_str() else {
        return -1;
    };
    let Some(text) = describe(name) else {
        *out_len = 0;
        return 1;
    };
    *out_len = text.len();
    if text.len() > out_cap {
        return 2;
    }
    std::ptr::copy_nonoverlapping(text.as_ptr(), out_buf, text.len());
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn parse(text: &str) -> (usize, Vec<(String, usize)>) {
        let mut parts = text.split(';');
        let size = parts
            .next()
            .and_then(|s| s.strip_prefix("size="))
            .and_then(|s| s.parse().ok())
            .expect("leading size=");
        let fields = parts
            .map(|p| {
                let (name, off) = p.split_once('=').expect("name=offset");
                (name.to_owned(), off.parse().expect("offset"))
            })
            .collect();
        (size, fields)
    }

    /// Every exported layout is well-formed, its offsets are strictly
    /// increasing (declaration order, no two fields aliasing) and end
    /// inside the struct, and the known-good `MapleAdjustmentParams` size
    /// the WinUI startup guard (`RawFfi.VerifyAbi`) pins is what we export.
    #[test]
    fn exported_layouts_are_ordered_and_bounded() {
        let names = [
            "MapleAdjustmentParams",
            "MapleToneCurves",
            "MapleSceneLinearBufferF32",
            "MapleAutoAdjustments",
            #[cfg(feature = "gpu")]
            "MapleGpuLiveParams",
            #[cfg(feature = "gpu")]
            "MapleGpuLiveSession",
        ];
        for name in names {
            let text = describe(name).unwrap_or_else(|| panic!("{name} exported"));
            let (size, fields) = parse(&text);
            assert!(!fields.is_empty(), "{name}: no fields");
            assert_eq!(fields[0].1, 0, "{name}: first field at offset 0");
            for w in fields.windows(2) {
                assert!(
                    w[0].1 < w[1].1,
                    "{name}: {} then {} not ascending",
                    w[0].0,
                    w[1].0
                );
            }
            assert!(
                fields.last().unwrap().1 < size,
                "{name}: last field inside the struct"
            );
        }
        let (size, _) = parse(&describe("MapleAdjustmentParams").unwrap());
        assert_eq!(
            size, 672,
            "RawFfi.VerifyAbi pins MapleAdjustmentParams at 672 bytes"
        );
    }

    #[test]
    fn extern_entry_writes_text_and_reports_errors() {
        let name = CString::new("MapleToneCurves").unwrap();
        let mut buf = vec![0u8; 4096];
        let mut len = 0usize;
        let rc = unsafe { maple_abi_layout(name.as_ptr(), buf.as_mut_ptr(), buf.len(), &mut len) };
        assert_eq!(rc, 0);
        assert_eq!(
            std::str::from_utf8(&buf[..len]).unwrap(),
            describe("MapleToneCurves").unwrap()
        );

        let mut small = [0u8; 4];
        let mut need = 0usize;
        let rc =
            unsafe { maple_abi_layout(name.as_ptr(), small.as_mut_ptr(), small.len(), &mut need) };
        assert_eq!(rc, 2);
        assert_eq!(need, len);

        let unknown = CString::new("NotAStruct").unwrap();
        let mut len = 7usize;
        let rc =
            unsafe { maple_abi_layout(unknown.as_ptr(), buf.as_mut_ptr(), buf.len(), &mut len) };
        assert_eq!(rc, 1);
        assert_eq!(len, 0);

        let rc =
            unsafe { maple_abi_layout(std::ptr::null(), buf.as_mut_ptr(), buf.len(), &mut len) };
        assert_eq!(rc, -1);
    }
}
