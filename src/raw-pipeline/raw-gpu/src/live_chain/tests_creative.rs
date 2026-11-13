//! The creative stage of the capture-first live chain (#5376) against the CPU
//! oracle, `CreativeStage::render_basis`: the real builder's creative passes
//! over signed and HDR capture-basis pixels, every table shape, a spread of
//! white balances, and every EXIF orientation.

use super::tests::neutral_case;
use super::*;
use crate::chain::ChainRunner;
use crate::context::GpuContext;
use crate::dehaze::AirlightSource;
use crate::image::GpuImage;
use crate::{CreativeInputs, CreativeTable, Pass};
use raw_core::image::{ColorSpace, Image};
use raw_core::pipeline::{CreativePlan, CreativeStage, PlanTable};
use raw_core::test_support::creative::{creative_stage, fallback_stage, Tables};
use raw_core::xmp::{AdjustmentModel, HighlightRecoveryMode};

const PARITY: f32 = 1e-4;

pub(super) fn table(t: &PlanTable) -> CreativeTable {
    CreativeTable {
        dims: t.dims,
        srgb: t.srgb,
        cold_offset: t.cold_offset,
        warm_offset: t.warm_offset,
        warm_weight: t.warm_weight,
    }
}

pub(crate) fn creative_inputs<'a>(plan: &CreativePlan<'a>) -> CreativeInputs<'a> {
    CreativeInputs {
        to_pro: plan.to_pro.0,
        from_pro: plan.from_pro.0,
        tables: plan.tables,
        hsm: plan.hsm.as_ref().map(table),
        look: plan.look.as_ref().map(table),
        highlight_recovery: plan.highlight_recovery,
        post: plan.post.0,
    }
}

/// Signed, out-of-gamut and HDR capture-basis pixels over a ramp, with the
/// extremes pinned: black, a pure channel, neutral grey, a negative channel.
pub(crate) fn capture_rgba(count: usize) -> Vec<f32> {
    let mut state = 0x2545_f491_u32;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        (state % 10_000) as f32 / 10_000.0
    };
    let mut pixels: Vec<f32> = (0..count)
        .flat_map(|i| {
            let level = 0.005 + 1.6 * next() * next();
            let mut p = [
                level * (0.1 + next()),
                level * (0.1 + next()),
                level * (0.1 + next()),
            ];
            if i % 7 == 0 {
                p[i % 3] = -0.06 * next();
            }
            if i % 11 == 0 {
                p = p.map(|v| v * 5.0);
            }
            [p[0], p[1], p[2], (i % 5) as f32 / 4.0]
        })
        .collect();
    let pinned: [[f32; 4]; 6] = [
        [0.0, 0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0, 1.0],
        [0.18, 0.18, 0.18, 1.0],
        [-0.05, 0.4, 0.3, 1.0],
        [-0.02, -0.01, 0.2, 1.0],
    ];
    for (i, p) in pinned.iter().enumerate() {
        pixels[i * 4..i * 4 + 4].copy_from_slice(p);
    }
    pixels
}

pub(super) fn image_of(rgba: &[f32], width: u32) -> Image {
    let height = (rgba.len() / 4) as u32 / width;
    let mut img = Image::new(width, height, ColorSpace::SceneLinearRec2020);
    for (p, q) in img.pixels.iter_mut().zip(rgba.chunks_exact(4)) {
        *p = [q[0], q[1], q[2]];
    }
    img
}

pub(crate) fn custom(
    temperature: f32,
    tint: f32,
    recovery: HighlightRecoveryMode,
) -> AdjustmentModel {
    AdjustmentModel {
        temperature,
        tint,
        temperature_seen: true,
        tint_seen: true,
        highlight_recovery: recovery,
        ..AdjustmentModel::default()
    }
}

pub(crate) fn white_balances() -> Vec<AdjustmentModel> {
    use HighlightRecoveryMode::{Off, OklabChromaReduction};
    vec![
        AdjustmentModel::default(),
        custom(3200.0, 12.0, Off),
        custom(9500.0, -18.0, OklabChromaReduction),
        custom(2000.0, 40.0, OklabChromaReduction),
        custom(50000.0, 0.0, Off),
    ]
}

/// Records every pass the live builder pushes and keeps the creative ones, so
/// the real gates and order are what the GPU runs.
pub(super) struct CreativeOnly<'a> {
    pub passes: Vec<Box<dyn Pass + 'a>>,
    pub names: Vec<&'static str>,
}

impl<'a> LivePassSink<'a> for CreativeOnly<'a> {
    fn push<T: Pass + 'a>(&mut self, pass: T) {
        let name = std::any::type_name::<T>();
        self.names.push(name);
        if name.contains("Creative") || name.contains("PostDcpHighlight") {
            self.passes.push(Box::new(pass));
        }
    }
}

pub(super) fn creative_sink<'a>(inputs: &'a FullChainInputs<'_>) -> CreativeOnly<'a> {
    let mut sink = CreativeOnly {
        passes: Vec::new(),
        names: Vec::new(),
    };
    visit_live_chain(inputs, AirlightSource::OnGpu, &mut sink);
    sink
}

pub(super) fn run_creative(
    ctx: &GpuContext,
    stage: &CreativeStage,
    model: &AdjustmentModel,
    rgba: &[f32],
    width: u32,
) -> Vec<f32> {
    let wire = stage.gpu_wire();
    let plan = stage.gpu_plan(&wire, model).unwrap();
    let inputs = FullChainInputs {
        creative: Some(creative_inputs(&plan)),
        ..neutral_case().gpu_inputs()
    };
    let sink = creative_sink(&inputs);
    let refs: Vec<&dyn Pass> = sink.passes.iter().map(|p| p.as_ref()).collect();
    let image = GpuImage::upload(ctx, rgba, width, (rgba.len() / 4) as u32 / width);
    ChainRunner::new(ctx, &image).run_blocking(&refs)
}

pub(super) fn worst_relative(gpu: &[f32], rgba: &[f32], cpu: &Image) -> f32 {
    gpu.chunks_exact(4)
        .zip(&cpu.pixels)
        .zip(rgba.chunks_exact(4))
        .map(|((g, c), source)| {
            assert_eq!(g[3], source[3], "alpha untouched");
            (0..3)
                .map(|k| (g[k] - c[k]).abs() / c[k].abs().max(1.0))
                .fold(0.0_f32, f32::max)
        })
        .fold(0.0_f32, f32::max)
}

fn assert_parity(ctx: &GpuContext, label: &str, stage: &CreativeStage, rgba: &[f32], width: u32) {
    for model in white_balances() {
        let (cpu, _) = stage.render_basis(image_of(rgba, width), &model).unwrap();
        let gpu = run_creative(ctx, stage, &model, rgba, width);
        let worst = worst_relative(&gpu, rgba, &cpu);
        eprintln!(
            "CREATIVE parity {label} T={} tint={}: max relative {worst:e}",
            model.temperature, model.tint
        );
        assert!(
            worst < PARITY,
            "{label} T={} tint={}: GPU vs CPU creative stage {worst}",
            model.temperature,
            model.tint
        );
    }
}

#[test]
fn creative_stage_matches_the_cpu_oracle_on_signed_and_hdr_input() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let rgba = capture_rgba(64 * 48);
    for (label, tables) in [
        ("matrix only", Tables::None),
        ("single table", Tables::SingleHueSatMap),
        ("dual linear", Tables::DualHueSatMap { srgb: false }),
        ("dual sRGB", Tables::DualHueSatMap { srgb: true }),
        ("dual + look", Tables::DualHueSatMapAndLook),
    ] {
        assert_parity(&ctx, label, &creative_stage(tables, 1.7), &rgba, 64);
    }
    let fallback = fallback_stage(Tables::SingleHueSatMap, 0.8);
    assert_parity(&ctx, "fallback", &fallback, &rgba, 64);
}

#[test]
fn exposure_gain_is_applied_after_recovery_and_the_tables() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let rgba = capture_rgba(32 * 32);
    let model = custom(4200.0, 6.0, HighlightRecoveryMode::OklabChromaReduction);
    let run = |gain: f32| {
        let stage = creative_stage(Tables::DualHueSatMapAndLook, gain);
        run_creative(&ctx, &stage, &model, &rgba, 32)
    };
    let (unit, boosted) = (run(1.0), run(2.5));
    let worst = unit
        .chunks_exact(4)
        .zip(boosted.chunks_exact(4))
        .flat_map(|(a, b)| (0..3).map(move |c| (a[c] * 2.5 - b[c]).abs() / b[c].abs().max(1.0)))
        .fold(0.0_f32, f32::max);
    assert!(
        worst < PARITY,
        "gain must scale the finished render: {worst}"
    );
}

/// The EXIF orientation takes the sensor-order upload to the upright frame;
/// the creative ops are pointwise, so a transposed or flipped upload gives
/// the transposed or flipped render.
fn oriented(rgba: &[f32], w: usize, h: usize, orientation: u32) -> (Vec<f32>, usize) {
    let (dw, dh) = if orientation >= 5 { (h, w) } else { (w, h) };
    let source = |x: usize, y: usize| match orientation {
        1 => (x, y),
        2 => (w - 1 - x, y),
        3 => (w - 1 - x, h - 1 - y),
        4 => (x, h - 1 - y),
        5 => (y, x),
        6 => (y, h - 1 - x),
        7 => (w - 1 - y, h - 1 - x),
        _ => (w - 1 - y, x),
    };
    let out = (0..dh)
        .flat_map(|y| (0..dw).map(move |x| (x, y)))
        .flat_map(|(x, y)| {
            let (sx, sy) = source(x, y);
            let i = (sy * w + sx) * 4;
            rgba[i..i + 4].to_vec()
        })
        .collect();
    (out, dw)
}

#[test]
fn all_eight_orientations_render_like_their_upright_counterpart() {
    let ctx = GpuContext::new_blocking().expect("gpu context");
    let (w, h) = (13usize, 7usize);
    let upright = capture_rgba(w * h);
    let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.3);
    let model = custom(3600.0, 14.0, HighlightRecoveryMode::OklabChromaReduction);
    let reference = run_creative(&ctx, &stage, &model, &upright, w as u32);
    for orientation in 1..=8u32 {
        let (upload, width) = oriented(&upright, w, h, orientation);
        let (expected, _) = oriented(&reference, w, h, orientation);
        let gpu = run_creative(&ctx, &stage, &model, &upload, width as u32);
        let (cpu, _) = stage
            .render_basis(image_of(&upload, width as u32), &model)
            .unwrap();
        let worst = worst_relative(&gpu, &upload, &cpu);
        let equivariance = gpu
            .iter()
            .zip(&expected)
            .map(|(a, b)| (a - b).abs() / b.abs().max(1.0))
            .fold(0.0_f32, f32::max);
        eprintln!(
            "CREATIVE orientation {orientation}: parity {worst:e} equivariance {equivariance:e}"
        );
        assert!(worst < PARITY, "orientation {orientation}: vs CPU {worst}");
        assert!(
            equivariance < 1e-6,
            "orientation {orientation}: {equivariance}"
        );
    }
}
