//! The creative stage as hosts carry it (#5377): the header and wire rebuild
//! the stage exactly, the header's GPU plan is the stage's, the wire carries
//! nothing specific to the photo, and the capture decode plus the creative
//! stage reproduces the develop.

use super::tests::{chart_raw, engaged_capture, max_relative_difference, warm_white_balance};
use super::tests_plan::{capture_pixels, models};
use super::*;
use crate::pipeline::{
    develop_scene_linear_from_raw_with_quality_with_gain,
    develop_scene_linear_sized_from_raw_with_quality_with_gain, render_capture_from_raw_f32,
    render_capture_sized_from_raw_f32, render_capture_tile_cancellable_f32,
    render_scene_linear_tile_cancellable_f32, RenderQuality, TileRect,
};
use crate::test_support::creative::{creative_stage, fallback_stage, Tables};
use crate::types::WbMethod;
use crate::xmp::HighlightRecoveryMode;

const SHAPES: [Tables; 5] = [
    Tables::None,
    Tables::SingleHueSatMap,
    Tables::DualHueSatMap { srgb: false },
    Tables::DualHueSatMap { srgb: true },
    Tables::DualHueSatMapAndLook,
];

fn stages() -> Vec<CreativeStage> {
    SHAPES
        .iter()
        .flat_map(|&tables| [creative_stage(tables, 1.6), fallback_stage(tables, 0.9)])
        .collect()
}

#[test]
fn the_header_and_wire_rebuild_the_stage_exactly() {
    for stage in stages() {
        for model in models() {
            let (header, wire) = stage.transport(model.highlight_recovery).unwrap();
            let rebuilt = header.stage(wire.floats()).unwrap();
            let (want, _) = stage.render_basis(capture_pixels(), &model).unwrap();
            let (got, _) = rebuilt.render_basis(capture_pixels(), &model).unwrap();
            assert_eq!(
                got.pixels, want.pixels,
                "T={} tint={}",
                model.temperature, model.tint
            );
        }
    }
}

/// Including an imported V1 pair, whose conversion reads the profile's
/// matrices: the header's tick resolves it as the stage does.
#[test]
fn the_header_plan_is_the_stage_plan() {
    let imported = AdjustmentModel {
        temperature: 4300.0,
        tint: 22.0,
        temperature_seen: true,
        tint_seen: true,
        wb_scale_version: crate::types::WbScaleVersion::V1,
        ..AdjustmentModel::default()
    };
    for stage in stages() {
        for model in models().into_iter().chain([imported.clone()]) {
            let (header, wire) = stage.transport(model.highlight_recovery).unwrap();
            let want = stage.gpu_plan(&wire, &model).unwrap();
            let got = header.gpu_plan(wire.floats(), header.tick(&model)).unwrap();
            assert_eq!(got.to_pro, want.to_pro);
            assert_eq!(got.from_pro, want.from_pro);
            assert_eq!(got.post, want.post);
            assert_eq!((got.hsm, got.look), (want.hsm, want.look));
            assert_eq!(got.highlight_recovery, want.highlight_recovery);
            assert_eq!(got.tables.as_ptr(), wire.floats().as_ptr());
        }
    }
}

#[test]
fn a_dual_illuminant_wire_holds_only_the_profile_tables() {
    let dual = creative_stage(Tables::DualHueSatMap { srgb: false }, 1.0).gpu_wire();
    assert_eq!(dual.layout().as_shot, AsShotTable::Endpoints);
    let (cold, warm) = dual.layout().endpoints.unwrap();
    assert_eq!(
        Some(dual.floats().len()),
        cold.len().zip(warm.len()).map(|(c, w)| c + w)
    );
    let single = creative_stage(Tables::SingleHueSatMap, 1.0).gpu_wire();
    assert!(matches!(single.layout().as_shot, AsShotTable::Table(_)));
}

#[test]
fn a_span_whose_dims_overflow_is_refused() {
    let stage = creative_stage(Tables::SingleHueSatMap, 1.0);
    let (header, wire) = stage.transport(HighlightRecoveryMode::Off).unwrap();
    let AsShotTable::Table(span) = header.tables.as_shot else {
        panic!("a single-table profile stores its table");
    };
    let damaged = CreativeHeader {
        tables: TableLayout {
            as_shot: AsShotTable::Table(TableSpan {
                dims: [u32::MAX, u32::MAX, u32::MAX],
                ..span
            }),
            ..header.tables
        },
        ..header
    };
    assert!(damaged.stage(wire.floats()).is_err());
}

#[test]
fn a_wire_from_another_profile_is_refused() {
    let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.0);
    let (header, wire) = stage.transport(HighlightRecoveryMode::Off).unwrap();
    let short = &wire.floats()[..wire.floats().len() - 1];
    let tick = CreativeTick {
        temperature: 4000.0,
        tint: 3.0,
        wb_method: WbMethod::Cat16,
    };
    assert!(header.gpu_plan(short, tick).is_err());
    assert!(header.stage(short).is_err());
    let mut measured = stage;
    measured.anchors = CreativeAnchors::Measure;
    assert!(measured.transport(HighlightRecoveryMode::Off).is_err());
}

fn image_of(width: u32, rgba: &[f32]) -> Image {
    let mut img = Image::new(
        width,
        (rgba.len() / 4) as u32 / width,
        ColorSpace::SceneLinearRec2020,
    );
    for (p, px) in img.pixels.iter_mut().zip(rgba.chunks_exact(4)) {
        *p = [px[0], px[1], px[2]];
    }
    img
}

fn post_neutral(model: AdjustmentModel) -> AdjustmentModel {
    AdjustmentModel {
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..model
    }
}

#[test]
fn the_capture_decode_and_its_creative_stage_reproduce_the_develop() {
    let raw = chart_raw();
    for decode in [engaged_capture(), AdjustmentModel::default()] {
        let decode = post_neutral(decode);
        let full =
            render_capture_from_raw_f32(&raw, &decode, RenderQuality::Full, CancelToken::never())
                .unwrap();
        let sized = render_capture_sized_from_raw_f32(
            &raw,
            &decode,
            RenderQuality::Full,
            48,
            CancelToken::never(),
        )
        .unwrap();
        for white_balance in [AdjustmentModel::default(), warm_white_balance()] {
            let model = AdjustmentModel {
                temperature: white_balance.temperature,
                tint: white_balance.tint,
                temperature_seen: white_balance.temperature_seen,
                tint_seen: white_balance.tint_seen,
                ..decode.clone()
            };
            let develops = [
                (
                    &full,
                    develop_scene_linear_from_raw_with_quality_with_gain(
                        &raw,
                        &model,
                        RenderQuality::Full,
                    ),
                ),
                (
                    &sized,
                    develop_scene_linear_sized_from_raw_with_quality_with_gain(
                        &raw,
                        &model,
                        RenderQuality::Full,
                        48,
                    ),
                ),
            ];
            for (capture, develop) in develops {
                let (want, want_gain) = develop.unwrap();
                assert!((capture.creative.ae_gain - want_gain).abs() <= 1e-6 * want_gain);
                let stage = capture.creative.stage(capture.tables.floats()).unwrap();
                let (got, _) = stage
                    .render_basis(image_of(capture.width, &capture.rgba), &model)
                    .unwrap();
                let worst = max_relative_difference(&got, &want);
                assert!(worst < 1e-4, "capture + creative vs develop {worst}");
                assert_eq!(capture.whites_anchor_ev, want.whites_anchor_ev.unwrap());
            }
        }
    }
}

#[test]
fn a_capture_tile_and_the_creative_stage_reproduce_the_scene_tile() {
    let raw = chart_raw();
    let decode = post_neutral(engaged_capture());
    let whole =
        render_capture_from_raw_f32(&raw, &decode, RenderQuality::Full, CancelToken::never())
            .unwrap();
    let rect = TileRect {
        src_x: 16,
        src_y: 16,
        src_w: 48,
        src_h: 48,
        out_w: 48,
        out_h: 48,
    };
    let (w, _, capture) = render_capture_tile_cancellable_f32(
        &raw,
        &decode,
        rect,
        RenderQuality::Full,
        CancelToken::never(),
    )
    .unwrap();
    let model = AdjustmentModel {
        temperature: 3600.0,
        tint: 18.0,
        temperature_seen: true,
        tint_seen: true,
        ..decode.clone()
    };
    let stage = whole.creative.stage(whole.tables.floats()).unwrap();
    let (got, _) = stage.render_basis(image_of(w, &capture), &model).unwrap();
    let (_, _, scene) = render_scene_linear_tile_cancellable_f32(
        &raw,
        &model,
        rect,
        RenderQuality::Full,
        None,
        whole.creative.ae_gain,
        CancelToken::never(),
    )
    .unwrap();
    let worst = max_relative_difference(&got, &image_of(w, &scene));
    assert!(
        worst < 1e-4,
        "capture tile + creative vs scene tile {worst}"
    );
}
