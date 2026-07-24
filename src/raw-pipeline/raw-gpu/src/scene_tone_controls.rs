//! Scene tone controls — a P2 scene-linear WGSL port (epic #925 / #990),
//! reworked at #1103 into a small spatial DAG (tone/zoom design § 4.2).
//!
//! Ports the six tone steps of `raw_core::stages::scene_tone_controls::apply`
//! (spec § 3.6 + § 4.1–4.2): exposure, brightness, highlights, shadows,
//! whites, blacks. The point steps (exposure/brightness and whites/blacks)
//! run in `scene_tone_controls.wgsl`; highlights and shadows are spatial
//! since #1103 — each is a `scene_tone_sh.wgsl` dispatch reading a
//! gaussian-blurred luma plane (σ = 15 px · longEdge/2000) prepared with the
//! shared `box_blur.wgsl` primitive, mirroring raw-core's per-step
//! `masked_multiplier_pass`. Like clarity/dehaze, the stage stays ONE
//! [`Pass`] from the chain's point of view and orchestrates the DAG over
//! pooled scratch buffers via [`crate::spatial`].
//!
//! Encode plan (stages whose sliders are inactive are skipped, exactly like
//! the Rust `apply_*` flags; when neither highlights nor shadows is active
//! the whole stage collapses to ONE point dispatch — the pre-#1103 shape):
//!
//! ```text
//! [point: exposure+brightness] → [luma → 3× box blur → SH(highlights)]
//!                              → [luma → 3× box blur → SH(shadows)]
//!                              → [point: whites+blacks]
//! ```
//!
//! Three pieces (the per-stage template):
//! 1. [`apply_scene_tone_controls`] — the CPU oracle: a faithful port of the
//!    Rust stage over a flat RGBA f32 buffer (now width/height-aware — the
//!    detail mask blurs a 2-D luma plane).
//! 2. [`SceneToneControlsPass`] — the GPU-resident [`Pass`]; carries the six
//!    slider values.
//! 3. The headless parity test (in `#[cfg(test)] mod tests`) — GPU vs
//!    `raw_core::stages::scene_tone_controls::apply` (the real stage, via the
//!    dev-dep) within 1e-4.

use crate::chain::Pass;
use crate::context::GpuContext;
use crate::spatial::{self, alloc_plane, alloc_rgba, box_blur_encode, encode_simple};

/// `repr(C)` params uniform for the POINT kernel (`scene_tone_controls.wgsl`):
/// exposure / brightness / whites / blacks + the RGBA pixel `count` + padding
/// to 32 bytes (8 × u32/f32; the kernel's `Params` matches). Highlights and
/// shadows left this struct at #1103 — they dispatch `scene_tone_sh.wgsl`
/// with [`ShParams`].
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    exposure: f32,
    brightness: f32,
    whites: f32,
    blacks: f32,
    count: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
}

/// `repr(C)` params uniform for the masked S/H kernel (`scene_tone_sh.wgsl`).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ShParams {
    count: u32,
    /// 0 = highlights, 1 = shadows.
    mode: u32,
    /// slider / 100 (signed).
    amount: f32,
    _pad0: u32,
}

/// Rec.2020 luma weights — verbatim from
/// `raw_core::stages::scene_tone_controls::LUMA_REC2020`.
const LUMA_REC2020: [f32; 3] = [0.2627, 0.6780, 0.0593];

// raw-core scene_tone_controls #1103 constants. Transcribed (raw-core is a
// dev-dep only); the parity test pins every one of them to the real stage.
const S_T1: f32 = 0.25;
const S_GAIN_EV: f32 = 1.5;
const H_W0: f32 = 0.25;
const H_W1: f32 = 1.0;
const H_GAIN_EV: f32 = 0.7;
const SH_MASK_EDGE0: f32 = 0.05;
const SH_MASK_EDGE1: f32 = 0.25;
const SH_MASK_SIGMA_REF_PX: f32 = 15.0;
const SH_MASK_REF_LONG_EDGE: f32 = 2000.0;
// Whites/blacks monotonicity bounds — transcribed from raw-core and pinned by
// the parity test. #2186 restores the positive Blacks toe to the 0.20 black
// range and halves its full-rail endpoint so it remains monotone.
const WHITES_MIN_GAIN: f32 = 0.32;
const B_CRUSH_EDGE: f32 = 0.2;
const B_LIFT_EDGE: f32 = 0.20;
const B_LIFT_MAX: f32 = 0.125;

#[inline]
fn luma(p: [f32; 3]) -> f32 {
    LUMA_REC2020[0] * p[0] + LUMA_REC2020[1] * p[1] + LUMA_REC2020[2] * p[2]
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// `raw_core::stages::scene_tone_controls::sh_mask_blur_radius`, transcribed:
/// blur radius (in 3×-box-pass gaussian terms) for the S/H detail mask at a
/// given long edge. σ = 15 px · longEdge/2000; radius = 3σ (box radius ≈ σ
/// per Wells 1986). The parity test pins the transcription.
fn sh_mask_blur_radius(long_edge: u32) -> u32 {
    let sigma = SH_MASK_SIGMA_REF_PX * (long_edge as f32) / SH_MASK_REF_LONG_EDGE;
    ((3.0 * sigma).round() as u32).max(1)
}

/// `shadows_mult` — verbatim from the raw-core stage (#1103).
fn shadows_mult(y: f32, s_amount: f32) -> f32 {
    let t = 1.0 - smoothstep(0.0, S_T1, y);
    let w = t * t;
    1.0 + ((S_GAIN_EV * s_amount).exp2() - 1.0) * w
}

/// `highlights_mult` — verbatim from the raw-core stage (#1103): weighted
/// gain engaging below clip + the sign-branched above-knee shape (h ≥ 0
/// keeps the legacy compression; h < 0 expands by the #1081 pole-free
/// mirror — do not collapse the branches back into one denominator).
fn highlights_mult(y: f32, h_amount: f32) -> f32 {
    let w = smoothstep(H_W0, H_W1, y);
    let g = (-H_GAIN_EV * h_amount * w).exp2();
    let shape = if y > 1.0 {
        let y_new = if h_amount >= 0.0 {
            1.0 + (y - 1.0) / (1.0 + h_amount * 2.0)
        } else {
            1.0 + (y - 1.0) * (1.0 + 2.0 * h_amount.abs())
        };
        y_new / y
    } else {
        1.0
    };
    shape * g
}

/// Serial separable box blur of a scalar plane — line-faithful local copy of
/// `raw_core::stages::blur::box_blur_channel` (`pub(crate)` there, so
/// unreachable from this crate; same precedent as the clarity oracle's copy).
/// Shrinking-window partial average; `r == 0` is identity.
fn box_blur_channel(buf: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 {
        return buf.to_vec();
    }
    let mut tmp = vec![0.0f32; buf.len()];
    for y in 0..h {
        let row = &buf[y * w..(y + 1) * w];
        let out_row = &mut tmp[y * w..(y + 1) * w];
        let right0 = r.min(w - 1);
        let mut acc: f32 = row[0..=right0].iter().sum();
        let mut count = right0 + 1;
        out_row[0] = acc / count as f32;
        for x in 1..w {
            if x + r < w {
                acc += row[x + r];
                count += 1;
            }
            if x > r {
                acc -= row[x - r - 1];
                count -= 1;
            }
            out_row[x] = acc / count as f32;
        }
    }
    let mut out = vec![0.0f32; buf.len()];
    for x in 0..w {
        let bot0 = r.min(h - 1);
        let mut acc: f32 = (0..=bot0).map(|i| tmp[i * w + x]).sum();
        let mut count = bot0 + 1;
        out[x] = acc / count as f32;
        for y in 1..h {
            if y + r < h {
                acc += tmp[(y + r) * w + x];
                count += 1;
            }
            if y > r {
                acc -= tmp[(y - r - 1) * w + x];
                count -= 1;
            }
            out[y * w + x] = acc / count as f32;
        }
    }
    out
}

/// `gaussian_blur_plane` — local copy of raw-core's 3×-box approximation
/// (Wells 1986): 3 passes of `box_blur_channel` at radius `radius/3`.
fn gaussian_blur_plane(buf: &[f32], w: usize, h: usize, radius: usize) -> Vec<f32> {
    if radius == 0 {
        return buf.to_vec();
    }
    let r_box = (radius / 3).max(1);
    let mut plane = buf.to_vec();
    for _ in 0..3 {
        plane = box_blur_channel(&plane, w, h, r_box);
    }
    plane
}

/// One masked S/H step over the interleaved RGBA buffer — the oracle mirror
/// of raw-core's `masked_multiplier_pass` + `scene_tone_sh.wgsl`.
fn masked_pass(buf: &mut [f32], width: usize, height: usize, mult_of_y: impl Fn(f32) -> f32) {
    let luma_plane: Vec<f32> = buf
        .chunks_exact(4)
        .map(|px| luma([px[0], px[1], px[2]]))
        .collect();
    let radius = sh_mask_blur_radius(width.max(height) as u32) as usize;
    let yb = gaussian_blur_plane(&luma_plane, width, height, radius);
    for (i, px) in buf.chunks_exact_mut(4).enumerate() {
        let y = luma_plane[i];
        let ybi = yb[i];
        let edge = (y.max(0.0).sqrt() - ybi.max(0.0).sqrt()).abs();
        let halo = smoothstep(SH_MASK_EDGE0, SH_MASK_EDGE1, edge);
        let m_regional = mult_of_y(ybi);
        let m_local = mult_of_y(y);
        let mult = m_regional + (m_local - m_regional) * halo;
        px[0] *= mult;
        px[1] *= mult;
        px[2] *= mult;
    }
}

#[derive(Clone, Copy)]
pub struct SceneToneOptions {
    pub exposure: f32,
    pub brightness: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
}

/// Scene-referred tone controls on an interleaved RGBA f32 buffer (alpha
/// untouched). This is the CPU oracle — a faithful port of
/// `raw_core::stages::scene_tone_controls::apply` (spec § 3.6 + § 4.1–4.2),
/// including the #1103 masked S/H steps (which is why it now needs
/// `width`/`height`: the detail mask blurs a 2-D luma plane).
///
/// The whole-image identity short-circuit (all six fields ~0) lives in
/// raw-core's `apply`; on the GPU the chain simply doesn't enqueue the pass,
/// mirroring vibrance. This function applies the per-field flags directly, so
/// it is a faithful oracle even when called with a partially-neutral model.
pub fn apply_scene_tone_controls(
    buf: &mut [f32],
    width: usize,
    height: usize,
    options: SceneToneOptions,
) {
    let SceneToneOptions {
        exposure,
        brightness,
        highlights,
        shadows,
        whites,
        blacks,
    } = options;
    debug_assert_eq!(buf.len(), width * height * 4);
    let apply_exposure = exposure.abs() >= 1e-6;
    let apply_brightness = brightness.abs() >= 1e-3;
    let apply_highlights = highlights.abs() >= 1e-3;
    let apply_shadows = shadows.abs() >= 1e-3;
    let apply_whites = whites.abs() >= 1e-3;
    let apply_blacks = blacks.abs() >= 1e-3;

    let exp_gain = exposure.exp2();
    // Brightness EV-per-unit-weight amount — raw-core B_STRENGTH = 0.7
    // (#1102, tone-zoom design § 4.1).
    let br_amount = 0.7 * brightness / 100.0;
    let h_amount = highlights / 100.0;
    let s_amount = shadows / 100.0;
    // Whites negative-gain floor (#1918); positive gain passes through unclamped.
    let w_amount = (whites / 200.0).max(-WHITES_MIN_GAIN);
    let b_amount = blacks / 100.0;
    let b_add_pos = B_LIFT_MAX * blacks / 100.0;

    // 1 + 1b. Exposure, then brightness — point ops.
    if apply_exposure || apply_brightness {
        for px in buf.chunks_exact_mut(4) {
            if apply_exposure {
                px[0] *= exp_gain;
                px[1] *= exp_gain;
                px[2] *= exp_gain;
            }
            if apply_brightness {
                let y = luma([px[0], px[1], px[2]]);
                let w = smoothstep(0.05, 0.25, y) * (1.0 - smoothstep(1.0, 4.0, y));
                let gain = (br_amount * w).exp2();
                px[0] *= gain;
                px[1] *= gain;
                px[2] *= gain;
            }
        }
    }

    // 2. Highlights — masked pass (#1103).
    if apply_highlights {
        masked_pass(buf, width, height, |y| highlights_mult(y, h_amount));
    }

    // 3. Shadows — masked pass (#1103), reading the post-highlights state.
    if apply_shadows {
        masked_pass(buf, width, height, |y| shadows_mult(y, s_amount));
    }

    // 4 + 5. Whites, then blacks — point ops.
    if apply_whites || apply_blacks {
        for px in buf.chunks_exact_mut(4) {
            if apply_whites {
                let y_old = luma([px[0], px[1], px[2]]);
                let w = smoothstep(0.5, 1.0, y_old);
                let w_gain = 1.0 + w_amount * w;
                px[0] *= w_gain;
                px[1] *= w_gain;
                px[2] *= w_gain;
            }
            if apply_blacks {
                let y_old = luma([px[0], px[1], px[2]]);
                if b_amount < 0.0 {
                    // Crush: multiplicative, 0.2 edge (B_CRUSH_EDGE) — unchanged.
                    let w = 1.0 - smoothstep(0.0, B_CRUSH_EDGE, y_old);
                    let factor = 1.0 + b_amount * w;
                    px[0] *= factor;
                    px[1] *= factor;
                    px[2] *= factor;
                } else {
                    // Lift: additive, 0.20 edge with 0.125 full-rail endpoint.
                    let w = 1.0 - smoothstep(0.0, B_LIFT_EDGE, y_old);
                    let delta = b_add_pos * w;
                    if y_old > 1e-6 {
                        let scale = (y_old + delta) / y_old;
                        px[0] *= scale;
                        px[1] *= scale;
                        px[2] *= scale;
                    } else {
                        px[0] += delta;
                        px[1] += delta;
                        px[2] += delta;
                    }
                }
            }
        }
    }
}

/// A GPU-resident scene-tone-controls stage. Carries the six slider values;
/// the device, pipelines, and ping-pong buffers come from the [`GpuContext`] /
/// [`ChainRunner`]. Encodes the #1103 DAG (point ops + per-step blurred-luma
/// masked S/H) over pooled scratch buffers.
pub struct SceneToneControlsPass {
    pub exposure: f32,
    pub brightness: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
}

/// The sub-stages of the scene-tone DAG, in chain order.
#[derive(Clone, Copy)]
enum Step {
    /// Point kernel: exposure + brightness (whites/blacks zeroed).
    PointPre,
    /// Masked kernel, mode 0.
    Highlights,
    /// Masked kernel, mode 1.
    Shadows,
    /// Point kernel: whites + blacks (exposure/brightness zeroed).
    PointPost,
    /// Single point kernel with all four fields — the collapsed fast path
    /// when neither highlights nor shadows is active.
    PointAll,
}

impl SceneToneControlsPass {
    fn encode_point(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        count: u32,
        fields: (f32, f32, f32, f32),
    ) {
        let (exposure, brightness, whites, blacks) = fields;
        let params = Params {
            exposure,
            brightness,
            whites,
            blacks,
            count,
            _pad0: 0,
            _pad1: 0,
            _pad2: 0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.scene_tone_controls_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, dst],
            count,
            "scene-tone-controls",
        );
    }

    /// Encode one masked S/H step: luma extract → 3× box blur (the
    /// `gaussian_blur_plane` 3-box approximation at radius/3) → the
    /// `scene_tone_sh.wgsl` mix dispatch.
    #[allow(clippy::too_many_arguments)]
    fn encode_masked(
        &self,
        ctx: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        src: &wgpu::Buffer,
        dst: &wgpu::Buffer,
        width: u32,
        height: u32,
        mode: u32,
        amount: f32,
    ) {
        let count = width * height;
        let luma = alloc_plane(ctx, width, height, "scene-tone-sh-luma");
        let luma2 = alloc_plane(ctx, width, height, "scene-tone-sh-luma2");
        // Reuses the clarity/texture luma-extract kernel; the luma² lane is
        // simply unused here.
        spatial::luma_extract_encode(ctx, encoder, src, &luma, &luma2, count);

        let r_box = (sh_mask_blur_radius(width.max(height)) / 3).max(1);
        let tmp = alloc_plane(ctx, width, height, "scene-tone-sh-blur");
        // 3 box passes: luma → tmp → luma → tmp (Yb ends in `tmp`), matching
        // raw-core's gaussian_blur_plane pass order exactly.
        box_blur_encode(ctx, encoder, &luma, &tmp, width, height, r_box);
        box_blur_encode(ctx, encoder, &tmp, &luma, width, height, r_box);
        box_blur_encode(ctx, encoder, &luma, &tmp, width, height, r_box);

        let params = ShParams {
            count,
            mode,
            amount,
            _pad0: 0,
        };
        encode_simple(
            ctx,
            encoder,
            ctx.scene_tone_sh_pipeline(),
            bytemuck::bytes_of(&params),
            &[src, &tmp, dst],
            count,
            "scene-tone-sh",
        );
    }
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
        let count = width * height;

        let apply_pre = self.exposure.abs() >= 1e-6 || self.brightness.abs() >= 1e-3;
        let apply_h = self.highlights.abs() >= 1e-3;
        let apply_s = self.shadows.abs() >= 1e-3;
        let apply_post = self.whites.abs() >= 1e-3 || self.blacks.abs() >= 1e-3;

        // Build the active step list in chain order.
        let mut steps: Vec<Step> = Vec::with_capacity(4);
        if !apply_h && !apply_s {
            // Fast path — the pre-#1103 single point dispatch (the kernel runs
            // 1 → 1b → 4 → 5 sequentially, identical to the Rust loops when
            // highlights/shadows are inactive).
            steps.push(Step::PointAll);
        } else {
            if apply_pre {
                steps.push(Step::PointPre);
            }
            if apply_h {
                steps.push(Step::Highlights);
            }
            if apply_s {
                steps.push(Step::Shadows);
            }
            if apply_post {
                steps.push(Step::PointPost);
            }
        }

        // Thread the steps through pooled RGBA scratch, last one landing on
        // `dst`. (The chain only enqueues this pass when at least one field is
        // active, but guard the degenerate empty list with a copy anyway.)
        if steps.is_empty() {
            let byte_len = (count as u64) * 4 * std::mem::size_of::<f32>() as u64;
            encoder.copy_buffer_to_buffer(src, 0, dst, 0, byte_len);
            return;
        }
        let scratch_a = alloc_rgba(ctx, width, height, "scene-tone-ping");
        let scratch_b = alloc_rgba(ctx, width, height, "scene-tone-pong");
        let mut cur: &wgpu::Buffer = src;
        for (i, step) in steps.iter().enumerate() {
            let last = i + 1 == steps.len();
            let out: &wgpu::Buffer = if last {
                dst
            } else if i % 2 == 0 {
                &scratch_a
            } else {
                &scratch_b
            };
            match step {
                Step::PointAll => self.encode_point(
                    ctx,
                    encoder,
                    cur,
                    out,
                    count,
                    (self.exposure, self.brightness, self.whites, self.blacks),
                ),
                Step::PointPre => self.encode_point(
                    ctx,
                    encoder,
                    cur,
                    out,
                    count,
                    (self.exposure, self.brightness, 0.0, 0.0),
                ),
                Step::PointPost => self.encode_point(
                    ctx,
                    encoder,
                    cur,
                    out,
                    count,
                    (0.0, 0.0, self.whites, self.blacks),
                ),
                Step::Highlights => self.encode_masked(
                    ctx,
                    encoder,
                    cur,
                    out,
                    width,
                    height,
                    0,
                    self.highlights / 100.0,
                ),
                Step::Shadows => self.encode_masked(
                    ctx,
                    encoder,
                    cur,
                    out,
                    width,
                    height,
                    1,
                    self.shadows / 100.0,
                ),
            }
            cur = out;
        }
    }
}

// Parity tests live in a sibling file to keep this module under the 600-LOC
// budget (mirrors clarity's `tests.rs` split). Native test builds only.
#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "scene_tone_controls/tests.rs"]
mod tests;
