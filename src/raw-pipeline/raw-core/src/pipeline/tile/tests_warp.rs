#![cfg(test)]
//! Tests for bounded tile development with DNG OpcodeList3 WarpRectilinear (#4288).
//!
//! Validates:
//! 1. Rejection of unsupported opcode forms (multi-opcode, GainMap, FixVignetteRadial,
//!    tangential distortion `kt != 0`, lateral CA differing per plane).
//! 2. Overlap and reach calculation for radial warp (including Hasselblad L3D-100c coefficients).
//! 3. Parity between tile and full develop with identity warp.
//! 4. Parity between tile and full develop with non-identity radial warp across
//!    multiple window locations (interior, off-center, border).
//! 5. Parity with spatial stages (clarity, sharpen, vignette, capture sharpening).
//! 6. Non-normal EXIF orientations with radial warp.
//! 7. Preview quality (half-res Bayer demosaic).

use super::tests_live_parity::camera_chart_raw;
use super::*;
use crate::image::{ExifOrientation, RawImage};
use crate::pipeline::develop_scene_linear_from_raw_with_quality;
use crate::pipeline::orient::apply_orientation_f32_rgba;
use crate::pipeline::pano::opcode_apply::warp_rectilinear_reach_px;
use crate::pipeline::pano::opcodes::{
    ActiveAreaRect, FixVignetteRadialOpcode, GainMapOpcode, PanoOpcode, WarpPlaneParams,
    WarpRectilinearOpcode,
};
use crate::xmp::{AdjustmentModel, AutoExposureMode};

fn make_warp_opcode(kr: [f64; 4], kt: [f64; 2]) -> WarpRectilinearOpcode {
    WarpRectilinearOpcode {
        planes: vec![WarpPlaneParams { kr, kt }],
        center_x: 0.5,
        center_y: 0.5,
    }
}

fn hasselblad_l3d_warp() -> WarpRectilinearOpcode {
    make_warp_opcode([0.984778, 0.035585, -0.075203, 0.054787], [0.0, 0.0])
}

fn identity_warp() -> WarpRectilinearOpcode {
    make_warp_opcode([1.0, 0.0, 0.0, 0.0], [0.0, 0.0])
}

fn attach_warp(raw: &mut RawImage, warp: WarpRectilinearOpcode) {
    let aa = ActiveAreaRect::full(raw.width, raw.height);
    let list = crate::pipeline::pano::opcodes::OpcodeList3 {
        opcodes: vec![PanoOpcode::WarpRectilinear(warp)],
        skipped_unknown: 0,
    };
    raw.opcode_list3 = Some((list, aa));
}

fn base_model() -> AdjustmentModel {
    AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    }
}

fn extract_rect_lanes(
    raw: &RawImage,
    model: &AdjustmentModel,
    rect: TileRect,
    quality: RenderQuality,
) -> (Vec<f32>, Vec<f32>) {
    let full =
        develop_scene_linear_from_raw_with_quality(raw, model, quality).expect("full develop");
    let full_rgba: Vec<f32> = full
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect();
    let (fw, _fh, full_oriented) =
        apply_orientation_f32_rgba(&full_rgba, full.width, full.height, raw.orientation);

    let (tw, th, tile_rgba) =
        render_scene_linear_tile_from_raw_with_quality_f32(raw, model, rect, quality)
            .expect("tile render");
    assert_eq!((tw, th), (rect.out_w, rect.out_h), "tile output dims");

    let mut full_lanes = Vec::with_capacity((rect.out_w * rect.out_h * 3) as usize);
    let fw = fw as usize;
    for y in 0..rect.out_h as usize {
        for x in 0..rect.out_w as usize {
            let idx = ((rect.src_y as usize + y) * fw + (rect.src_x as usize + x)) * 4;
            full_lanes.extend_from_slice(&full_oriented[idx..idx + 3]);
        }
    }

    let mut tile_lanes = Vec::with_capacity((rect.out_w * rect.out_h * 3) as usize);
    for chunk in tile_rgba.chunks_exact(4) {
        tile_lanes.extend_from_slice(&chunk[0..3]);
    }

    (full_lanes, tile_lanes)
}

fn max_abs(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(x, y)| {
            assert!(x.is_finite() && y.is_finite(), "non-finite lane");
            (x - y).abs()
        })
        .fold(0.0f32, f32::max)
}

#[test]
fn reject_unsupported_opcode_forms() {
    let mut raw = camera_chart_raw();
    let model = base_model();
    let rect = TileRect {
        src_x: 96,
        src_y: 96,
        src_w: 128,
        src_h: 128,
        out_w: 128,
        out_h: 128,
    };
    let aa = ActiveAreaRect::full(raw.width, raw.height);

    // 1. GainMap
    raw.opcode_list3 = Some((
        crate::pipeline::pano::opcodes::OpcodeList3 {
            opcodes: vec![PanoOpcode::GainMap(GainMapOpcode {
                top: 0,
                left: 0,
                bottom: 100,
                right: 100,
                plane: 0,
                planes: 1,
                row_pitch: 1,
                col_pitch: 1,
                points_v: 2,
                points_h: 2,
                spacing_v: 1.0,
                spacing_h: 1.0,
                origin_v: 0.0,
                origin_h: 0.0,
                map_planes: 1,
                gains: vec![1.0; 4],
            })],
            skipped_unknown: 0,
        },
        aa,
    ));
    assert!(guards::reject_untileable(&raw, &model, rect).is_err());

    // 2. FixVignetteRadial
    raw.opcode_list3 = Some((
        crate::pipeline::pano::opcodes::OpcodeList3 {
            opcodes: vec![PanoOpcode::FixVignetteRadial(FixVignetteRadialOpcode {
                k: [1.0, 0.0, 0.0, 0.0, 0.0],
                center_x: 0.5,
                center_y: 0.5,
            })],
            skipped_unknown: 0,
        },
        aa,
    ));
    assert!(guards::reject_untileable(&raw, &model, rect).is_err());

    // 3. Multi-opcode
    raw.opcode_list3 = Some((
        crate::pipeline::pano::opcodes::OpcodeList3 {
            opcodes: vec![
                PanoOpcode::WarpRectilinear(identity_warp()),
                PanoOpcode::WarpRectilinear(identity_warp()),
            ],
            skipped_unknown: 0,
        },
        aa,
    ));
    assert!(guards::reject_untileable(&raw, &model, rect).is_err());

    // 4. Tangential kt != 0
    raw.opcode_list3 = Some((
        crate::pipeline::pano::opcodes::OpcodeList3 {
            opcodes: vec![PanoOpcode::WarpRectilinear(make_warp_opcode(
                [1.0, 0.0, 0.0, 0.0],
                [0.05, 0.0],
            ))],
            skipped_unknown: 0,
        },
        aa,
    ));
    assert!(guards::reject_untileable(&raw, &model, rect).is_err());

    // 5. Differing planes (lateral CA)
    raw.opcode_list3 = Some((
        crate::pipeline::pano::opcodes::OpcodeList3 {
            opcodes: vec![PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
                planes: vec![
                    WarpPlaneParams {
                        kr: [1.0, 0.0, 0.0, 0.0],
                        kt: [0.0, 0.0],
                    },
                    WarpPlaneParams {
                        kr: [1.02, 0.0, 0.0, 0.0],
                        kt: [0.0, 0.0],
                    },
                ],
                center_x: 0.5,
                center_y: 0.5,
            })],
            skipped_unknown: 0,
        },
        aa,
    ));
    assert!(guards::reject_untileable(&raw, &model, rect).is_err());
}

#[test]
fn hasselblad_l3d_reach_calculation() {
    let warp = hasselblad_l3d_warp();
    let reach_full = warp_rectilinear_reach_px(&warp, (12288, 8192), 1.0);
    let reach_half = warp_rectilinear_reach_px(&warp, (12288 / 2, 8192 / 2), 1.0);
    assert_eq!(reach_full, 55, "Hasselblad L3D-100c full-res reach");
    assert_eq!(reach_half, 29, "Hasselblad L3D-100c half-res reach");

    let mut raw = camera_chart_raw();
    raw.width = 12288;
    raw.height = 8192;
    attach_warp(&mut raw, warp);
    let model = base_model();
    let overlap = overlap::tile_overlap_px(Some(&raw), &model, 0, 1);
    assert_eq!(overlap, 63, "overlap includes warp reach: {overlap}");

    let rect = TileRect {
        src_x: 96,
        src_y: 96,
        src_w: 128,
        src_h: 128,
        out_w: 128,
        out_h: 128,
    };
    let working = tile_working_pixels(&raw, &model, rect, RenderQuality::Full).unwrap();
    let min_expected =
        ((rect.src_w + 2 * TILE_OVERLAP_PX) * (rect.src_h + 2 * TILE_OVERLAP_PX)) as u64;
    assert!(
        working > min_expected,
        "working pixels buffer accounts for warp reach: {working} > {min_expected}"
    );
}

#[test]
fn identity_warp_matches_full_develop() {
    let mut raw = camera_chart_raw();
    attach_warp(&mut raw, identity_warp());
    let model = base_model();

    for (desc, rect) in [
        (
            "interior",
            TileRect {
                src_x: 96,
                src_y: 96,
                src_w: 128,
                src_h: 128,
                out_w: 128,
                out_h: 128,
            },
        ),
        (
            "off-center",
            TileRect {
                src_x: 160,
                src_y: 120,
                src_w: 128,
                src_h: 128,
                out_w: 128,
                out_h: 128,
            },
        ),
    ] {
        let (full, tile) = extract_rect_lanes(&raw, &model, rect, RenderQuality::Full);
        let diff = max_abs(&full, &tile);
        assert!(diff < 1e-4, "{desc} identity warp diff too high: {diff}");
    }
}

#[test]
fn hasselblad_radial_warp_parity_across_windows() {
    let mut raw = camera_chart_raw();
    let unwarped_raw = camera_chart_raw();
    attach_warp(&mut raw, hasselblad_l3d_warp());
    let model = base_model();

    let interior_rect = TileRect {
        src_x: 96,
        src_y: 96,
        src_w: 128,
        src_h: 128,
        out_w: 128,
        out_h: 128,
    };

    // 1. Verify warp actively changes pixel values vs unwarped baseline
    let (full_unwarped, _) =
        extract_rect_lanes(&unwarped_raw, &model, interior_rect, RenderQuality::Full);
    let (full_warped, tile_warped) =
        extract_rect_lanes(&raw, &model, interior_rect, RenderQuality::Full);

    let warp_effect = max_abs(&full_unwarped, &full_warped);
    assert!(
        warp_effect > 1e-3,
        "warp must alter pixels, got effect: {warp_effect}"
    );

    // 2. Parity between full and tile develop for interior window
    let diff = max_abs(&full_warped, &tile_warped);
    assert!(
        diff < 1e-4,
        "interior window warped tile diff too high: {diff}"
    );

    // 3. Parity for off-center window
    let offcenter_rect = TileRect {
        src_x: 140,
        src_y: 100,
        src_w: 128,
        src_h: 128,
        out_w: 128,
        out_h: 128,
    };
    let (full_off, tile_off) =
        extract_rect_lanes(&raw, &model, offcenter_rect, RenderQuality::Full);
    let diff_off = max_abs(&full_off, &tile_off);
    assert!(
        diff_off < 1e-4,
        "offcenter window warped tile diff too high: {diff_off}"
    );

    // 4. Parity for corner window where sensor boundary clamping engages
    let corner_rect = TileRect {
        src_x: 0,
        src_y: 0,
        src_w: 128,
        src_h: 128,
        out_w: 128,
        out_h: 128,
    };
    let (full_corner, tile_corner) =
        extract_rect_lanes(&raw, &model, corner_rect, RenderQuality::Full);
    let diff_corner = max_abs(&full_corner, &tile_corner);
    assert!(
        diff_corner < 1e-4,
        "corner window warped tile diff too high: {diff_corner}"
    );
}

#[test]
fn radial_warp_parity_with_spatial_sliders() {
    let mut raw = camera_chart_raw();
    attach_warp(&mut raw, hasselblad_l3d_warp());

    let model = AdjustmentModel {
        highlights: -20.0,
        shadows: 20.0,
        clarity: 15.0,
        vignette_amount: -30.0,
        vignette_feather: 50.0,
        capture_sharpening_amount: 40.0,
        capture_sharpening_sigma: 1.2,
        ..base_model()
    };

    let rect = TileRect {
        src_x: 96,
        src_y: 96,
        src_w: 128,
        src_h: 128,
        out_w: 128,
        out_h: 128,
    };
    let (full, tile) = extract_rect_lanes(&raw, &model, rect, RenderQuality::Full);
    let diff = max_abs(&full, &tile);
    assert!(
        diff < 1e-4,
        "spatial sliders with radial warp diff too high: {diff}"
    );
}

#[test]
fn radial_warp_with_non_normal_orientation() {
    let mut raw = camera_chart_raw();
    raw.orientation = ExifOrientation::Rotate90;
    attach_warp(&mut raw, hasselblad_l3d_warp());
    let model = base_model();

    // With Rotate90, display coordinates swap width and height
    let rect = TileRect {
        src_x: 96,
        src_y: 96,
        src_w: 128,
        src_h: 128,
        out_w: 128,
        out_h: 128,
    };
    let (full, tile) = extract_rect_lanes(&raw, &model, rect, RenderQuality::Full);
    let diff = max_abs(&full, &tile);
    assert!(diff < 1e-4, "Rotate90 radial warp diff too high: {diff}");
}

#[test]
fn radial_warp_preview_quality_half_res() {
    let mut raw = camera_chart_raw();
    attach_warp(&mut raw, hasselblad_l3d_warp());
    let model = base_model();

    let rect = TileRect {
        src_x: 96,
        src_y: 96,
        src_w: 128,
        src_h: 128,
        out_w: 64,
        out_h: 64,
    };

    let (w, h, rgba) = render_scene_linear_tile_from_raw_with_quality_f32(
        &raw,
        &model,
        rect,
        RenderQuality::Preview,
    )
    .expect("preview tile render");
    assert_eq!((w, h), (64, 64));
    assert_eq!(rgba.len(), (w * h * 4) as usize);

    // Parity vs full develop at Preview quality
    let full = develop_scene_linear_from_raw_with_quality(&raw, &model, RenderQuality::Preview)
        .expect("full preview develop");
    let full_rgba: Vec<f32> = full
        .pixels
        .iter()
        .flat_map(|p| [p[0], p[1], p[2], 1.0])
        .collect();
    let (fw, _fh, full_oriented) =
        apply_orientation_f32_rgba(&full_rgba, full.width, full.height, raw.orientation);

    let fw = fw as usize;
    let mut full_lanes = Vec::with_capacity((64 * 64 * 3) as usize);
    for y in 0..64 {
        for x in 0..64 {
            let idx = (((rect.src_y / 2) as usize + y) * fw + ((rect.src_x / 2) as usize + x)) * 4;
            full_lanes.extend_from_slice(&full_oriented[idx..idx + 3]);
        }
    }
    let mut tile_lanes = Vec::with_capacity((64 * 64 * 3) as usize);
    for chunk in rgba.chunks_exact(4) {
        tile_lanes.extend_from_slice(&chunk[0..3]);
    }
    let diff = max_abs(&full_lanes, &tile_lanes);
    assert!(
        diff < 1e-4,
        "preview tile vs full preview diff too high: {diff}"
    );
}
