//! The GPU plan (#5376) is the CPU creative stage written as constants: run
//! pixel by pixel on the CPU it reproduces `CreativeStage::render`.

use super::*;
use crate::color::{
    dcp,
    hsm::{self, HsmEncoding, HsmTable},
};
use crate::stages::highlight_recovery_oklab;
use crate::test_support::creative::{creative_stage, fallback_stage, Tables};
use crate::xmp::HighlightRecoveryMode;

pub(super) fn capture_pixels() -> Image {
    let mut img = Image::new(16, 12, ColorSpace::SceneLinearRec2020);
    let mut state = 0x9e37_79b9_u32;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state % 10_000) as f32 / 10_000.0
    };
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let level = 0.01 + 1.4 * next();
        *p = [
            level * (0.1 + next()),
            level * (0.1 + next()),
            level * (0.1 + next()),
        ];
        if i % 9 == 0 {
            p[i % 3] = -0.04 * next();
        }
        if i % 13 == 0 {
            *p = p.map(|v| v * 4.0);
        }
    }
    img
}

fn floats<'a>(plan: &CreativePlan<'a>, t: &PlanTable, offset: usize) -> &'a [f32] {
    let len = t.dims.iter().map(|&d| d as usize).product::<usize>() * 3;
    &plan.tables[offset..offset + len]
}

fn encoding(t: &PlanTable) -> HsmEncoding {
    if t.srgb {
        HsmEncoding::Srgb
    } else {
        HsmEncoding::Linear
    }
}

fn single(plan: &CreativePlan<'_>, t: &PlanTable) -> HsmTable {
    HsmTable::new(t.dims, floats(plan, t, t.cold_offset).to_vec(), encoding(t)).unwrap()
}

fn through(plan: &CreativePlan<'_>, p: [f32; 3], mode: HighlightRecoveryMode) -> [f32; 3] {
    let table = |t: &PlanTable, p: [f32; 3]| match t.warm_offset {
        Some(warm) => hsm::apply_one_blended(
            p,
            t.dims,
            encoding(t),
            (floats(plan, t, t.cold_offset), floats(plan, t, warm)),
            t.warm_weight,
        ),
        None => hsm::apply_one(p, &single(plan, t)),
    };
    let pro = plan.to_pro.mul_vec(p);
    let pro = plan.hsm.as_ref().map_or(pro, |t| table(t, pro));
    let pro = plan.look.as_ref().map_or(pro, |t| {
        let mut one = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
        one.pixels[0] = pro;
        dcp::apply_look_table(&mut one, &single(plan, t));
        one.pixels[0]
    });
    let out = plan.from_pro.mul_vec(pro);
    let lift = (-out[0].min(out[1]).min(out[2])).max(0.0);
    let mut one = Image::new(1, 1, ColorSpace::SceneLinearRec2020);
    one.pixels[0] = out.map(|v| v + lift);
    if plan.highlight_recovery {
        highlight_recovery_oklab::apply_post_dcp(&mut one, mode);
    }
    plan.post.mul_vec(one.pixels[0])
}

pub(super) fn models() -> Vec<AdjustmentModel> {
    let custom = |temperature: f32, tint: f32, recovery: HighlightRecoveryMode| AdjustmentModel {
        temperature,
        tint,
        temperature_seen: true,
        tint_seen: true,
        highlight_recovery: recovery,
        ..AdjustmentModel::default()
    };
    vec![
        AdjustmentModel::default(),
        custom(3200.0, 12.0, HighlightRecoveryMode::Off),
        custom(9500.0, -18.0, HighlightRecoveryMode::OklabChromaReduction),
        custom(2000.0, 40.0, HighlightRecoveryMode::OklabChromaReduction),
        custom(50000.0, 0.0, HighlightRecoveryMode::Off),
    ]
}

fn relative_difference(a: [f32; 3], b: [f32; 3]) -> f32 {
    (0..3)
        .map(|c| (a[c] - b[c]).abs() / b[c].abs().max(1.0))
        .fold(0.0, f32::max)
}

fn assert_plan_reproduces_render(label: &str, stage: &CreativeStage) {
    for model in models() {
        let capture = capture_pixels();
        let (reference, _) = stage.render_basis(capture.clone(), &model).unwrap();
        let wire = stage.gpu_wire();
        let plan = stage.gpu_plan(&wire, &model).unwrap();
        let worst = capture
            .pixels
            .iter()
            .zip(&reference.pixels)
            .map(|(p, want)| {
                relative_difference(through(&plan, *p, model.highlight_recovery), *want)
            })
            .fold(0.0, f32::max);
        assert!(
            worst < 1e-4,
            "{label} T={} tint={}: plan vs render {worst}",
            model.temperature,
            model.tint
        );
    }
}

#[test]
fn the_plan_reproduces_the_creative_stage_for_every_table_shape() {
    for (label, tables) in [
        ("matrix only", Tables::None),
        ("single table", Tables::SingleHueSatMap),
        ("dual linear", Tables::DualHueSatMap { srgb: false }),
        ("dual sRGB", Tables::DualHueSatMap { srgb: true }),
        ("dual + look", Tables::DualHueSatMapAndLook),
    ] {
        assert_plan_reproduces_render(label, &creative_stage(tables, 1.7));
        assert_plan_reproduces_render(label, &creative_stage(tables, 1.0));
    }
}

#[test]
fn the_plan_reproduces_the_uncalibrated_tiers_post_dcp_white_balance() {
    for tables in [Tables::None, Tables::SingleHueSatMap] {
        assert_plan_reproduces_render("fallback", &fallback_stage(tables, 0.8));
    }
}

#[test]
fn the_as_shot_table_is_the_endpoints_blended_at_the_as_shot_cct() {
    let stage = creative_stage(Tables::DualHueSatMap { srgb: false }, 1.0);
    let wire = stage.gpu_wire();
    let e = stage.profile.cm_endpoints.unwrap();
    let as_shot = stage
        .gpu_plan(&wire, &AdjustmentModel::default())
        .unwrap()
        .hsm
        .unwrap();
    assert_eq!(
        Some(as_shot.warm_weight),
        dcp::hsm_lerp_weight(e.cct_cold, e.cct_warm, stage.profile.scene_cct)
    );
    let warm = stage.gpu_plan(&wire, &models()[1]).unwrap().hsm.unwrap();
    assert_eq!(warm.warm_offset, as_shot.warm_offset);
    assert!(warm.warm_offset.is_some() && (0.0..=1.0).contains(&warm.warm_weight));
    assert_ne!(warm.warm_weight, as_shot.warm_weight);
}

#[test]
fn the_plan_needs_a_given_exposure_gain_and_an_absolute_white_balance() {
    let mut stage = creative_stage(Tables::None, 1.0);
    stage.anchors = CreativeAnchors::Measure;
    let wire = stage.gpu_wire();
    assert!(stage.gpu_plan(&wire, &AdjustmentModel::default()).is_err());
    stage.anchors = CreativeAnchors::Given {
        ae_gain: 1.0,
        decoded_wb: Some((5000.0, 0.0)),
    };
    assert!(stage.gpu_plan(&wire, &AdjustmentModel::default()).is_err());
}

#[test]
fn the_tables_and_the_white_balance_move_pixels_so_the_gate_is_not_vacuous() {
    let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.0);
    let model = &models()[2];
    let capture = capture_pixels();
    let (reference, _) = stage.render_basis(capture.clone(), model).unwrap();
    let wire = stage.gpu_wire();
    let plan = stage.gpu_plan(&wire, model).unwrap();
    let bare = CreativePlan {
        hsm: None,
        look: None,
        ..plan.clone()
    };
    let moved_by_tables = capture
        .pixels
        .iter()
        .zip(&reference.pixels)
        .map(|(p, want)| relative_difference(through(&bare, *p, model.highlight_recovery), *want))
        .fold(0.0, f32::max);
    assert!(moved_by_tables > 1e-2, "tables moved {moved_by_tables}");
    let as_shot = stage.gpu_plan(&wire, &AdjustmentModel::default()).unwrap();
    assert_ne!(as_shot.to_pro.0, plan.to_pro.0);
}
