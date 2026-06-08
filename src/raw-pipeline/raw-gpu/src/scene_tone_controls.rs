//! Scene tone controls — a P2 scene-linear WGSL port (epic #925 / #990).
//!
//! Mirrors the vibrance template. Ports the five luma-coupled tone steps of
//! `raw_core::stages::scene_tone_controls::apply` (spec § 3.6): exposure,
//! highlights, shadows, whites, blacks — applied SEQUENTIALLY with luma
//! recomputed from the running pixel at each step (the parity-critical detail).
//! Contrast and the parametric / tone-curve steps are intentionally excluded:
//! the Rust stage applies neither here (contrast modulates the AgX slope
//! downstream).
//!
//! Three pieces (the per-stage template):
//! 1. [`apply_scene_tone_controls`] — the CPU oracle: a line-for-line port of
//!    the Rust stage's per-pixel loop over a flat RGBA f32 buffer.
//! 2. [`SceneToneControlsPass`] — the GPU-resident [`Pass`]; carries the five
//!    slider values.
//! 3. The headless parity test (in `#[cfg(test)] mod tests`) — GPU vs
//!    `raw_core::stages::scene_tone_controls::apply` (the real stage, via the
//!    test-only `raw-core` dev-dep) `< 1e-4` across a spread of slider combos.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::encode_simple;

/// `repr(C)` params uniform shared by the WGSL kernel
/// (`scene_tone_controls.wgsl`): the five raw slider values + the RGBA pixel
/// `count` + padding to 32 bytes (8 × u32/f32; the kernel's `Params` matches).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    exposure: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    count: u32,
    _pad0: u32,
    _pad1: u32,
}

/// Rec.2020 luma weights — verbatim from
/// `raw_core::stages::scene_tone_controls::LUMA_REC2020`. Kept here as the local
/// oracle's copy; the WGSL kernel inlines the same triple. (A stage-local
/// constant, not a codegen color matrix.)
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

#[inline]
fn luma(p: [f32; 3]) -> f32 {
    LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2]
}

#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Scene-referred tone controls on an interleaved RGBA f32 buffer (alpha
/// untouched). This is the CPU oracle — a line-for-line port of the per-pixel
/// loop in `raw_core::stages::scene_tone_controls::apply` (spec § 3.6). The five
/// steps run sequentially with luma recomputed from the running pixel at each;
/// every per-field threshold and nested guard is reproduced.
///
/// The whole-image identity short-circuit (all five fields ~0) lives in
/// raw-core's `apply`; on the GPU the chain simply doesn't enqueue the pass,
/// mirroring vibrance. This function applies the per-field flags directly, so it
/// is a faithful oracle even when called with a partially-neutral model.
pub fn apply_scene_tone_controls(
    buf: &mut [f32],
    exposure: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
) {
    let apply_exposure = exposure.abs() >= 1e-6;
    let apply_highlights = highlights.abs() >= 1e-3;
    let apply_shadows = shadows.abs() >= 1e-3;
    let apply_whites = whites.abs() >= 1e-3;
    let apply_blacks = blacks.abs() >= 1e-3;

    let exp_gain = exposure.exp2();

    let h_amount = highlights / 100.0;
    let h_denom = 1.0 + h_amount * 2.0;

    let s_amount = shadows / 100.0;
    let s_factor = s_amount * 0.5;

    let w_amount = whites / 200.0;

    let b_amount = blacks / 100.0; // -1..+1
    let b_add_pos = blacks / 400.0; // additive lift amount, positive branch only

    for px in buf.chunks_exact_mut(4) {
        // 1. Exposure.
        if apply_exposure {
            px[0] *= exp_gain;
            px[1] *= exp_gain;
            px[2] *= exp_gain;
        }

        // 2. Highlights — luminance-coupled soft compression above knee = 1.0.
        if apply_highlights && h_denom.abs() > 1e-6 {
            let y_old = luma([px[0], px[1], px[2]]);
            if y_old > 1.0 {
                let y_new = 1.0 + (y_old - 1.0) / h_denom;
                let scale = y_new / y_old;
                px[0] *= scale;
                px[1] *= scale;
                px[2] *= scale;
            }
        }

        // 3. Shadows — luminance-masked lift of deep values.
        if apply_shadows {
            let l = luma([px[0], px[1], px[2]]);
            let mask = 1.0 - smoothstep(0.0, 0.1, l);
            let lift = mask * s_factor;
            px[0] += px[0] * lift;
            px[1] += px[1] * lift;
            px[2] += px[2] * lift;
        }

        // 4. Whites — smoothstep-weighted gain near the diffuse-white endpoint.
        if apply_whites {
            let y_old = luma([px[0], px[1], px[2]]);
            let w = smoothstep(0.5, 1.0, y_old);
            let w_gain = 1.0 + w_amount * w;
            px[0] *= w_gain;
            px[1] *= w_gain;
            px[2] *= w_gain;
        }

        // 5. Blacks — smoothstep-weighted toe (sign-branched).
        if apply_blacks {
            let y_old = luma([px[0], px[1], px[2]]);
            let w = 1.0 - smoothstep(0.0, 0.2, y_old);
            if b_amount < 0.0 {
                let factor = 1.0 + b_amount * w;
                px[0] *= factor;
                px[1] *= factor;
                px[2] *= factor;
            } else {
                let delta = b_add_pos * w;
                px[0] += delta;
                px[1] += delta;
                px[2] += delta;
            }
        }
        // px[3] (alpha) untouched
    }
}

/// A GPU-resident scene-tone-controls stage. Carries the five slider values; the
/// device, pipeline, and ping-pong buffers come from the [`GpuContext`] /
/// [`ChainRunner`]. Builds its own params uniform + bind group in `encode`.
pub struct SceneToneControlsPass {
    pub exposure: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
}

impl Pass for SceneToneControlsPass {
    fn encode(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        dims: (u32, u32),
    ) {
        let (width, height) = dims;
        let pixel_count = width * height;

        let params = Params {
            exposure: self.exposure,
            highlights: self.highlights,
            shadows: self.shadows,
            whites: self.whites,
            blacks: self.blacks,
            count: pixel_count,
            _pad0: 0,
            _pad1: 0,
        };
        // Pooled per-pixel dispatch (P4b-core C3): params @0, src @1, dst @2.
        encode_simple(
            ctx,
            encoder,
            ctx.scene_tone_controls_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            pixel_count,
            "scene-tone-controls",
        );
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::chain::ChainRunner;
    use crate::image::GpuImage;
    use raw_core::AdjustmentModel;

    /// A buffer that exercises every branch the tone steps depend on:
    ///   - DEEP shadow (Y < 0.1) → shadows mask ≈ 1, blacks toe ≈ 1,
    ///   - midtone (Y ~ 0.18) → whites/blacks weights ≈ 0 (untouched region),
    ///   - HDR-headroom (Y > 1.0) → the highlights `y_old > 1.0` compression
    ///     branch (the only path that fires for highlights),
    ///   - near-white (Y ~ 1.0) → whites smoothstep saturates,
    ///   - a slightly-negative channel (sign handling through the scalars).
    fn tone_buffer() -> Vec<f32> {
        vec![
            // r,    g,    b,    a
            0.01, 0.01, 0.01, 1.0, // deep shadow → shadows lift + blacks toe
            0.18, 0.18, 0.18, 0.7, // midtone (whites/blacks weight ~0)
            0.50, 0.50, 0.50, 1.0, // upper-mid (whites smoothstep ramps in)
            0.95, 0.95, 0.95, 1.0, // near diffuse white
            3.00, 2.00, 1.20, 1.0, // HDR headroom → highlights compression
            0.04, 0.30, 0.50, 0.5, // colored shadow (luma-coupled scale, hue test)
            -0.01, 0.06, 0.02, 1.0, // tiny-negative channel
            0.70, 0.20, 0.10, 1.0, // saturated warm midtone
        ]
    }

    /// Run `raw_core::stages::scene_tone_controls::apply` on a flat interleaved
    /// RGBA f32 buffer with the given slider values, returning a new buffer
    /// (alpha carried through). The ticket's actual reference — the Rust stage.
    fn raw_core_tone(
        buf: &[f32],
        exposure: f32,
        highlights: f32,
        shadows: f32,
        whites: f32,
        blacks: f32,
    ) -> Vec<f32> {
        use raw_core::image::{ColorSpace, Image};
        let count = buf.len() / 4;
        let mut img = Image::new(count as u32, 1, ColorSpace::SceneLinearRec2020);
        for (i, chunk) in buf.chunks_exact(4).enumerate() {
            img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
        }
        // Only the five tone fields are set; everything else stays at default.
        // (The stage reads only exposure/highlights/shadows/whites/blacks.)
        let model = AdjustmentModel {
            exposure,
            highlights,
            shadows,
            whites,
            blacks,
            ..Default::default()
        };
        raw_core::stages::scene_tone_controls::apply(&mut img, &model);
        let mut out = Vec::with_capacity(buf.len());
        for (i, p) in img.pixels.iter().enumerate() {
            out.extend_from_slice(&[p[0], p[1], p[2], buf[i * 4 + 3]]);
        }
        out
    }

    /// The slider combinations under test — each deliberately drives a different
    /// mix of branches (and at least one field non-zero so the stage doesn't
    /// whole-image short-circuit). `(exposure, highlights, shadows, whites, blacks)`.
    const CASES: &[(f32, f32, f32, f32, f32)] = &[
        (1.0, 0.0, 0.0, 0.0, 0.0),       // exposure only
        (0.0, 60.0, 0.0, 0.0, 0.0),      // highlights compression only
        (0.0, 0.0, 80.0, 0.0, 0.0),      // shadows lift only
        (0.0, 0.0, 0.0, 75.0, 0.0),      // whites gain only
        (0.0, 0.0, 0.0, 0.0, 50.0),      // blacks lift (positive → additive)
        (0.0, 0.0, 0.0, 0.0, -70.0),     // blacks crush (negative → multiplicative)
        (0.5, 40.0, 30.0, 20.0, -25.0),  // everything together
        (-1.0, -50.0, -40.0, -60.0, 90.0), // negative exposure + mixed signs
    ];

    /// THE PARITY GATE (the ticket's contract): the WGSL scene-tone-controls
    /// kernel matches `raw_core::stages::scene_tone_controls::apply` — the
    /// actual Rust stage, via the test-only raw-core dev-dep — within 1e-4
    /// across a spread of slider combinations exercising each step's branches.
    #[test]
    fn wgsl_scene_tone_controls_matches_raw_core_stage_within_1e_4() {
        let ctx = GpuContext::new_blocking();
        let input = tone_buffer();
        let count = (input.len() / 4) as u32;

        for &(e, h, s, w, b) in CASES {
            let reference = raw_core_tone(&input, e, h, s, w, b);

            let img = GpuImage::upload(&ctx, &input, count, 1);
            let runner = ChainRunner::new(&ctx, &img);
            let gpu = runner.run_blocking(&[&SceneToneControlsPass {
                exposure: e,
                highlights: h,
                shadows: s,
                whites: w,
                blacks: b,
            }]);

            let max_diff = reference
                .iter()
                .zip(&gpu)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            eprintln!(
                "PARITY vs raw-core scene_tone_controls (e={e} h={h} s={s} w={w} b={b}): \
                 max abs diff = {max_diff:e}"
            );
            assert!(
                max_diff < 1e-4,
                "(e={e} h={h} s={s} w={w} b={b}): GPU vs raw-core stage max abs diff \
                 {max_diff} exceeds 1e-4"
            );
        }
    }

    /// Pin the local CPU oracle to raw-core's stage too, so the convenience
    /// oracle this crate exports can't silently drift. (The GPU gate above
    /// doesn't depend on the local oracle.)
    #[test]
    fn local_oracle_matches_raw_core_stage_within_1e_4() {
        let input = tone_buffer();
        for &(e, h, s, w, b) in CASES {
            let reference = raw_core_tone(&input, e, h, s, w, b);
            let mut local = input.clone();
            apply_scene_tone_controls(&mut local, e, h, s, w, b);
            let max_diff = reference
                .iter()
                .zip(&local)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0_f32, f32::max);
            assert!(
                max_diff < 1e-4,
                "(e={e} h={h} s={s} w={w} b={b}): local oracle vs raw-core stage diff \
                 {max_diff} exceeds 1e-4"
            );
        }
    }

    /// Sub-threshold sliders are a bit-exact passthrough on the GPU (the
    /// per-field activation guard). Pins that values below the |·| ≥ 1e-3 (or
    /// 1e-6 for exposure) thresholds don't perturb pixels — the per-field
    /// analogue of the Rust stage's identity short-circuit.
    #[test]
    fn subthreshold_sliders_are_passthrough_on_gpu() {
        let ctx = GpuContext::new_blocking();
        let input = tone_buffer();
        let count = (input.len() / 4) as u32;
        let img = GpuImage::upload(&ctx, &input, count, 1);
        let runner = ChainRunner::new(&ctx, &img);
        let gpu = runner.run_blocking(&[&SceneToneControlsPass {
            exposure: 1e-7,
            highlights: 1e-4,
            shadows: -1e-4,
            whites: 1e-4,
            blacks: -1e-4,
        }]);
        let max_diff = input
            .iter()
            .zip(&gpu)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0_f32, f32::max);
        assert_eq!(
            max_diff, 0.0,
            "sub-threshold tone sliders must be a bit-exact passthrough"
        );
    }

    /// Oracle sanity, independent of the GPU: positive shadows LIFT a deep-
    /// shadow pixel (the defining shadows property) while leaving a bright
    /// pixel essentially untouched (the luma mask dies above Y = 0.1).
    #[test]
    fn oracle_shadows_lift_deep_not_bright() {
        let mut buf = vec![0.02_f32, 0.02, 0.02, 1.0, 0.9, 0.9, 0.9, 1.0];
        apply_scene_tone_controls(&mut buf, 0.0, 0.0, 80.0, 0.0, 0.0);
        assert!(buf[0] > 0.02, "deep shadow should lift, got {}", buf[0]);
        assert!(
            (buf[4] - 0.9).abs() < 1e-3,
            "bright pixel should be ~untouched by shadows, got {}",
            buf[4]
        );
    }
}
