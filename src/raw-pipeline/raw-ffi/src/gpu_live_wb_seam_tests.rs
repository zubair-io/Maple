//! Fixture-gated GPU-live WB seam measurements (#1781/#1976/#1967) — split
//! out of `gpu_live_wb_frame_tests.rs` per the 600-LOC budget. That file's
//! layers 1 (marshalling) and 2 (frame-parity, real Metal, synthetic data)
//! stay there; this file is layer 3 — the fixture-gated live-vs-refine
//! seam on real bodies, requiring `test-fixtures/raws` (never runs in CI).
//! Reuses `gpu_live_wb_frame_tests`'s `pub(super)` `gpu_render`/`set_frame`
//! helpers and `gpu_live_tests`'s `pub(super)` params helpers.

use super::gpu_live_tests::{make_params, owned_arrays};
use super::gpu_live_wb_frame_tests::{gpu_render, set_frame};
use super::*;
use raw_core::image::{ColorSpace, Image};
use raw_core::stages::wb_camera::SliderFrameExport;
use raw_core::types::WbMethod;
use raw_core::view::acr_fit::model::{ciede2000, srgb_linear_to_lab};
use raw_core::view::auto_profile::curve::ProfileCurve;
use raw_core::view::auto_profile::lut::ColorLut;
use raw_core::xmp::AdjustmentModel;

/// Decode-gamma helper for the seam metric: u8 sRGB → linear sRGB.
fn srgb_decode(c: u8) -> f32 {
    let v = c as f32 / 255.0;
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Mean / p95 / max ΔE00 between two same-size u8 RGB surfaces.
fn de00_stats(a: &[u8], b: &[u8]) -> (f32, f32, f32) {
    let mut des: Vec<f32> = a
        .chunks_exact(3)
        .zip(b.chunks_exact(3))
        .map(|(pa, pb)| {
            let la =
                srgb_linear_to_lab([srgb_decode(pa[0]), srgb_decode(pa[1]), srgb_decode(pa[2])]);
            let lb =
                srgb_linear_to_lab([srgb_decode(pb[0]), srgb_decode(pb[1]), srgb_decode(pb[2])]);
            ciede2000(la, lb)
        })
        .collect();
    des.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let mean = des.iter().sum::<f32>() / des.len() as f32;
    let p95 = des[((des.len() as f32 * 0.95) as usize).min(des.len() - 1)];
    let max = *des.last().unwrap();
    (mean, p95, max)
}

/// Max per-channel u8 divergence between two surfaces.
fn max_channel_delta(a: &[u8], b: &[u8]) -> u8 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (*x as i16 - *y as i16).unsigned_abs() as u8)
        .max()
        .unwrap()
}

/// THE LIVE-vs-REFINE SEAM (fixture-gated, real Metal): test_0002 through
/// the GPU live chain over the ACTUAL editor decode bake, vs a fresh full
/// develop at the same target — the truth.
///
/// The bake models the strip-XMP decode faithfully (#1976): the strip
/// OMITS the WB fields (`omitWhiteBalance`, #1883), so raw-core resolves
/// the develop at the image's As-Shot WB — NOT at an explicit 6500/0.
/// Pre-#1894 those were the same develop (6500/0 was the slider identity
/// encoding); post-#1894 the identity moved to the frame's as-shot pair
/// and the explicit-6500/0 bake model became a ~2000 K-warm fiction on
/// this body. Anchoring the delta at that fiction "cooled" the neutral
/// as-shot buffer into the shipped cyan overcool — and the old version of
/// this test (bake at explicit 6500/0, single target 6282 ≈ anchor) baked
/// the same false assumption into the gate, so it stayed green. The delta
/// anchor here is the frame's as-shot pair, matching
/// `EditSession.wbDeltaAnchor`.
///
/// Cases:
///   * as-shot-open — the untouched editor open. The delta short-circuits
///     to exact identity AND the refine develops at the explicit as-shot
///     slider values, so this also gates the estimator/reconstruction
///     round trip (#1870): a saved untouched sidecar must develop to the
///     same pixels the open showed.
///   * sidecar — this fixture's real authored WB (6282 K / −44).
///   * warm-drag / cool-drag — large slider excursions in both
///     directions, the regime the old single-target gate never exercised.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn gpu_live_vs_develop_refine_seam_test_0002() {
    use raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable as render_sized;
    use raw_core::pipeline::RenderQuality;
    use raw_core::CancelToken;

    let path = raw_core::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read test_0002.dng");
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode test_0002");
    let frame = crate::scene_linear_f32::wb_frame_export(&raw);
    assert!(frame.is_present(), "test_0002 must resolve a slider frame");
    let anchor = (frame.scene_cct, frame.as_shot_tint);

    // The editor decode bake: WB UNSEEN (the strip XMP omits the fields),
    // AE off + sharpen/NR zeroed — WB is the stage under test; the live
    // chain and the develop run the others with different numerics.
    let model_bake = AdjustmentModel {
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let never = CancelToken::never();
    let (w, h, bake_f32) = render_sized(
        &raw,
        &model_bake,
        RenderQuality::Preview,
        512,
        never.clone(),
    )
    .expect("bake develop");

    let curve = ProfileCurve::identity();
    let lut = ColorLut::identity(2);
    let null_auto = |p: &mut MapleGpuLiveParams| {
        p.profile_curve_ptr = std::ptr::null();
        p.profile_curve_len = 0;
        p.residual_lut_size = 0;
        p.residual_lut_ptr = std::ptr::null();
        p.residual_lut_len = 0;
    };

    // Measured landings (2026-07-13, #1967) + ~15% headroom, all four now
    // dither-level:
    //   as-shot-open 0.045/0.504/1.573 maxCh 1 (identity short-circuit)
    //   sidecar      0.038/0.405/1.544 maxCh 2 (Δ ≈ 1760 K off anchor)
    //   warm-drag    0.029/0.399/1.016 maxCh 4 (Δ ≈ 3000 K)
    //   cool-drag    0.032/0.323/1.201 maxCh 1 (Δ ≈ 1000 K)
    // #1967 replaced the #1904 fixed-C approximation (which could not carry
    // the render profile's FM endpoints — budgets were 0.55–0.85 mean here
    // before this ticket) with the EXACT per-target/per-anchor `C(target)`/
    // `C(anchor)` (`SliderFrameExport::c_at`, via
    // `wb_camera::retargeted_render_profile` + `dcp::camera_to_rec2020_matrix`
    // — the SAME functions the CPU develop's DCP stage runs), so every case
    // now sits at the same dither floor as the identity short-circuit —
    // this is a one-way ratchet DOWN, not a relaxation.
    let cases: [(&str, (f32, f32), (f32, f32, f32)); 4] = [
        ("as-shot-open", anchor, (0.06, 0.6, 1.8)),
        ("sidecar", (6282.0, -44.0), (0.05, 0.5, 1.75)),
        ("warm-drag", (7500.0, 20.0), (0.04, 0.5, 1.2)),
        ("cool-drag", (3500.0, -20.0), (0.04, 0.4, 1.4)),
    ];

    for (name, target, (b_mean, b_p95, b_max)) in cases {
        // Truth: a fresh full develop at the explicit target + view tail.
        let model_target = AdjustmentModel {
            temperature: target.0,
            tint: target.1,
            temperature_seen: true,
            tint_seen: true,
            ..model_bake.clone()
        };
        let (tw, th, refine_f32) = render_sized(
            &raw,
            &model_target,
            RenderQuality::Preview,
            512,
            never.clone(),
        )
        .expect("refine develop");
        assert_eq!((w, h), (tw, th));
        let refine_u8 = {
            let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
            for (i, chunk) in refine_f32.chunks_exact(4).enumerate() {
                img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
            }
            raw_core::view::agx::apply(&mut img, 0.0);
            raw_core::view::encode::rec2020_to_srgb(&mut img);
            raw_core::view::encode::srgb_gamma_encode(&mut img);
            let mut rgba = Vec::with_capacity(refine_f32.len());
            for p in &img.pixels {
                rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
            }
            raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
        };

        // Live: the GPU chain over the as-shot bake, anchored at the
        // frame's as-shot pair (`wbDeltaAnchor`).
        let arr = owned_arrays(&model_target, &curve, &lut);
        let mut p = make_params(&model_target, WbMethod::Cat16, 2, &arr);
        p.decoded_temperature = anchor.0;
        p.decoded_tint = anchor.1;
        null_auto(&mut p);
        set_frame(&mut p, &frame);
        let live = gpu_render(&bake_f32, w, h, &p);

        let (mean, p95, max) = de00_stats(&live, &refine_u8);
        let ch = max_channel_delta(&live, &refine_u8);
        eprintln!(
            "test_0002 live-vs-refine seam [{name}] @ ({:.1}, {:.1}): \
             mean/p95/max dE00 = {mean:.3}/{p95:.3}/{max:.3} maxCh {ch}",
            target.0, target.1
        );
        assert!(
            mean < b_mean,
            "[{name}] live-vs-refine mean dE00 {mean:.3} exceeds budget {b_mean}"
        );
        assert!(
            p95 < b_p95,
            "[{name}] live-vs-refine p95 dE00 {p95:.3} exceeds budget {b_p95}"
        );
        assert!(
            max < b_max,
            "[{name}] live-vs-refine max dE00 {max:.3} exceeds budget {b_max}"
        );
        if name == "as-shot-open" {
            // The untouched open is delta-identity + gate-skip: the ONLY
            // residual is the explicit-vs-unseen as-shot develop round
            // trip (#1870) landing under dither — never more than 1 u8
            // step on any channel.
            assert!(
                ch <= 1,
                "[{name}] untouched open must be dither-level (maxCh {ch} > 1)"
            );
        }
    }
}

/// THE TILE-BAKE PARITY GATE (fixture-gated; #1976 follow-on): the
/// native-detail tile render with NO decoded-WB anchor must reproduce the
/// whole-image strip develop (an As-Shot bake) — the invariant that makes
/// the 100% native-detail overlay agree with the fit view, since both then
/// feed the SAME per-tick chain with the SAME `wbDeltaAnchor`.
///
/// Also documents WHY the anchor must be absent: the stripped handle model
/// carries the (6500, 0) parse DEFAULTS (WB omitted, #1883), so an anchored
/// tile computes `wb(6500-default)/wb(anchor)` in camera space — identity
/// only when the anchor is 6500/0 (the pre-#1976 accidental cancellation),
/// and a visible warm cast for any truthful anchor (measured on-device as
/// the pink 100% view).
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn native_detail_tile_bake_matches_whole_image_strip_develop() {
    use raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable as render_sized;
    use raw_core::pipeline::render_scene_linear_tile_from_raw_with_quality_and_wb_anchor_f32 as render_tile;
    use raw_core::pipeline::{RenderQuality, TileRect};
    use raw_core::CancelToken;

    let path = raw_core::test_support::fixtures::require_raw("test_0002.dng");
    let bytes = std::fs::read(&path).expect("read test_0002.dng");
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode test_0002");

    // The stripped handle model: WB omitted (unseen, parse defaults). AE
    // explicitly off — the tile path omits AE by design (#1167, a uniform
    // luminance factor, not color), so turning it off in the whole develop
    // isolates the COLOR parity this gate is about.
    let model_strip = AdjustmentModel {
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };

    // Whole-image strip develop at native resolution (long edge = sensor).
    let never = CancelToken::never();
    let native_long = raw.width.max(raw.height);
    let (ww, _wh, whole) =
        render_sized(&raw, &model_strip, RenderQuality::Full, native_long, never)
            .expect("whole-image strip develop");

    // A background rect well inside the frame (top-left quadrant is the
    // white studio backdrop on this fixture).
    let rect = TileRect {
        src_x: 256,
        src_y: 256,
        src_w: 512,
        src_h: 512,
        out_w: 512,
        out_h: 512,
    };

    let mean_rgb = |buf: &[f32], w: u32, x0: u32, y0: u32, n: u32| -> [f64; 3] {
        let mut acc = [0.0f64; 3];
        for yy in y0..y0 + n {
            for xx in x0..x0 + n {
                let i = ((yy * w + xx) * 4) as usize;
                acc[0] += buf[i] as f64;
                acc[1] += buf[i + 1] as f64;
                acc[2] += buf[i + 2] as f64;
            }
        }
        let cnt = (n * n) as f64;
        [acc[0] / cnt, acc[1] / cnt, acc[2] / cnt]
    };

    // Fixed fix: NO anchor — must match the whole develop.
    let (tw, th, tile_none) = render_tile(&raw, &model_strip, rect, RenderQuality::Full, None)
        .expect("tile render (no anchor)");
    assert_eq!((tw, th), (512, 512));
    // Pre-#1976 shape: a truthful as-shot anchor — documents the warm cast.
    let (_, _, tile_anchored) = render_tile(
        &raw,
        &model_strip,
        rect,
        RenderQuality::Full,
        Some((4522.4, -43.79)),
    )
    .expect("tile render (anchored)");

    let whole_mean = mean_rgb(&whole, ww, rect.src_x + 64, rect.src_y + 64, 384);
    let none_mean = mean_rgb(&tile_none, 512, 64, 64, 384);
    let anch_mean = mean_rgb(&tile_anchored, 512, 64, 64, 384);
    let ratio = |a: [f64; 3], b: [f64; 3]| [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
    let r_none = ratio(none_mean, whole_mean);
    let r_anch = ratio(anch_mean, whole_mean);
    eprintln!(
        "TILEBAKE whole={whole_mean:.5?} tile(none)={none_mean:.5?} ratio={r_none:.4?} | \
         tile(anchored 4522)={anch_mean:.5?} ratio={r_anch:.4?}"
    );
    for (c, r) in r_none.iter().enumerate() {
        assert!(
            (r - 1.0).abs() < 0.005,
            "no-anchor tile channel {c} diverges from the whole-image strip develop: ratio {r:.4}"
        );
    }
    // The anchored tile's R/B ratio vs the develop demonstrates the warm
    // cast the anchor injects (R up, B down) — the regression this test
    // pins. If this ever reads ~1.0 the anchor semantics changed and the
    // NativeDetail contract should be revisited.
    assert!(
        r_anch[0] > 1.01 && r_anch[2] < 0.99,
        "expected the truthful-anchor tile to show the documented warm cast; got {r_anch:.4?}"
    );
}

/// #1967 acceptance criterion 3 (regression guard): the exact per-CCT
/// `C(target)`/`C(anchor)` path must not regress a body's seam vs the
/// #1904 fixed-C fallback it replaces. For each named fixture, measures
/// BOTH tiers against the SAME fresh develop (via the SAME already-shipped
/// `rec2020_delta_matrix`, forcing the fixed-C tier by zeroing the new
/// `render_*` fields on a second copy of the export) and asserts the exact
/// tier's mean ΔE00 is ≤ the fixed tier's + 0.02.
fn assert_exact_c_does_not_regress_vs_fixed_c(raw_name: &str, target: (f32, f32)) {
    use raw_core::pipeline::render_scene_linear_sized_from_raw_with_quality_f32_cancellable as render_sized;
    use raw_core::pipeline::RenderQuality;
    use raw_core::CancelToken;

    let path = raw_core::test_support::fixtures::require_raw(raw_name);
    let bytes = std::fs::read(&path).expect("read fixture");
    let ext = std::path::Path::new(raw_name)
        .extension()
        .unwrap()
        .to_str()
        .unwrap();
    let raw = raw_core::decode::decode_bytes(&bytes, ext).expect("decode fixture");
    let frame_exact = crate::scene_linear_f32::wb_frame_export(&raw);
    assert!(
        frame_exact.is_present(),
        "{raw_name} must resolve a slider frame"
    );
    let anchor = (frame_exact.scene_cct, frame_exact.as_shot_tint);
    // Same export, new #1967 fields zeroed — forces the #1904 fixed-C
    // fallback tier via the SAME production `rec2020_delta_matrix`.
    let frame_fixed = SliderFrameExport {
        render_forward_matrix: raw_core::math::Matrix3([[0.0; 3]; 3]),
        render_cm_cold: raw_core::math::Matrix3([[0.0; 3]; 3]),
        render_cct_cold: 0.0,
        render_cm_warm: raw_core::math::Matrix3([[0.0; 3]; 3]),
        render_cct_warm: 0.0,
        render_fm_cold: raw_core::math::Matrix3([[0.0; 3]; 3]),
        render_fm_warm: raw_core::math::Matrix3([[0.0; 3]; 3]),
        ..frame_exact
    };

    let base = AdjustmentModel {
        auto_exposure: raw_core::types::adjustment::AutoExposureMode::Off,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let never = CancelToken::never();
    let (w, h, bake_f32) = render_sized(&raw, &base, RenderQuality::Preview, 512, never.clone())
        .expect("bake develop");
    let model_target = AdjustmentModel {
        temperature: target.0,
        tint: target.1,
        temperature_seen: true,
        tint_seen: true,
        ..base
    };
    let (tw, th, refine_f32) =
        render_sized(&raw, &model_target, RenderQuality::Preview, 512, never)
            .expect("refine develop");
    assert_eq!((w, h), (tw, th));
    let refine_u8 = {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (i, chunk) in refine_f32.chunks_exact(4).enumerate() {
            img.pixels[i] = [chunk[0], chunk[1], chunk[2]];
        }
        raw_core::view::agx::apply(&mut img, 0.0);
        raw_core::view::encode::rec2020_to_srgb(&mut img);
        raw_core::view::encode::srgb_gamma_encode(&mut img);
        let mut rgba = Vec::with_capacity(refine_f32.len());
        for p in &img.pixels {
            rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
        }
        raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
    };

    let render_via = |frame: &SliderFrameExport| -> Vec<u8> {
        let mut buf = bake_f32.clone();
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (i, c) in buf.chunks_exact(4).enumerate() {
            img.pixels[i] = [c[0], c[1], c[2]];
        }
        frame.apply_delta_rec2020(&mut img, target, anchor);
        for (i, p) in img.pixels.iter().enumerate() {
            buf[i * 4] = p[0];
            buf[i * 4 + 1] = p[1];
            buf[i * 4 + 2] = p[2];
        }
        let mut img2 = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for (i, c) in buf.chunks_exact(4).enumerate() {
            img2.pixels[i] = [c[0], c[1], c[2]];
        }
        raw_core::view::agx::apply(&mut img2, 0.0);
        raw_core::view::encode::rec2020_to_srgb(&mut img2);
        raw_core::view::encode::srgb_gamma_encode(&mut img2);
        let mut rgba = Vec::with_capacity(buf.len());
        for p in &img2.pixels {
            rgba.extend_from_slice(&[p[0], p[1], p[2], 1.0]);
        }
        raw_gpu::dither_and_quantize(&rgba, w as usize, h as usize)
    };

    let exact_u8 = render_via(&frame_exact);
    let fixed_u8 = render_via(&frame_fixed);
    let (mean_exact, _, _) = de00_stats(&exact_u8, &refine_u8);
    let (mean_fixed, _, _) = de00_stats(&fixed_u8, &refine_u8);
    eprintln!(
        "{raw_name} @ {target:?} (anchor {anchor:?}): exact-C mean dE00={mean_exact:.3} \
         vs fixed-C mean dE00={mean_fixed:.3}"
    );
    assert!(
        mean_exact <= mean_fixed + 0.02,
        "{raw_name}: #1967 exact-C ({mean_exact:.3}) regressed vs the #1904 fixed-C \
         fallback ({mean_fixed:.3}) by more than the 0.02 guard"
    );
}

/// Regression fixture (a): a dual-embedded-CM DNG whose render profile has
/// NO ForwardMatrix — so `retargeted_render_profile` never changes
/// `forward_matrix` (always `None`) and `c_at` is CONSTANT across every
/// target/anchor for this body; the delta reduces algebraically to the
/// SAME `C · diag(g_t/g_a) · C⁻¹` shape as the fixed-C tier, differing only
/// in which fixed `C` — exact uses `profile.scene_white_xyz` (the render
/// profile's OWN Bradford source, what a real develop's DCP stage
/// literally reads); fixed-C reconstructs an approximate one from the
/// VALUE frame's `(scene_cct, as_shot_tint)`.
///
/// This body is a deliberately hard case: its render profile carries real
/// HSM (ProfileHueSatMap) data — a chromaticity-dependent correction
/// NEITHER tier's linear-only `camera_to_rec2020_matrix` captures — AND
/// the render profile's own native CCT (7452 K) diverges ~1950 K from the
/// VALUE frame's as-shot (5508 K, the anchor here). At a REALISTIC drag
/// (tested here, ±500 K / ±15 tint) exact-C wins clearly either direction
/// (measured: cool 0.591 vs 1.343, warm 0.951 vs 1.961 mean ΔE00). Past
/// ~1000 K of cool excursion on this specific body BOTH tiers degrade
/// past the primary <0.1 acceptance bar (HSM dominates, not the C choice)
/// and which one is fractionally "less bad" flips a few times before
/// exact-C pulls back ahead beyond ~2500 K (measured sweep, 2026-07-13):
/// -200K 0.62/1.61, -500K 0.59/1.34, -1000K 1.70/1.33, -1500K 3.55/2.79,
/// -2000K 5.44/5.02, -2500K 7.05/7.64 (exact/fixed). Neither tier is
/// acceptable in that extreme-cool-on-a-frame-divergent-HSM-body regime;
/// closing it needs HSM in the delta, out of #1967's scope (raw-core
/// issue filed separately). The regression guard below uses the
/// REALISTIC drag, matching how a user actually moves the slider.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn test_0000_dual_embedded_cm_dng_does_not_regress() {
    assert_exact_c_does_not_regress_vs_fixed_c("test_0000.DNG", (5008.3, -16.9));
}

/// Regression fixture (b): a vendor RAW (profile-frame — value frame ==
/// render profile by construction) whose render profile DOES carry a
/// ForwardMatrix pair, exercising the real retargeting path on a
/// non-test_0002 body.
#[test]
#[cfg_attr(
    not(feature = "fixtures"),
    ignore = "needs test-fixtures/raws (fixtures feature)"
)]
fn test_0011_vendor_raw_profile_frame_does_not_regress() {
    assert_exact_c_does_not_regress_vs_fixed_c("test_0011.ARW", (8500.0, 40.0));
}
