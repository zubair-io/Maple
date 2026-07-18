//! Native (Metal) host parity gate for `render_bytes_gpu` (epic #925, P4b-web /
//! #1029).
//!
//! `render_bytes_gpu` is `#[wasm_bindgen]` (wasm-only) and its display path runs
//! on WebGPU, which the headless CI/host environment can't drive. But everything
//! the entry adds ON TOP of the merged-and-already-parity-proven P4b-core — the
//! decode-boundary split (stripped-prefix develop → post-AE buffer), the Auto
//! Profile fit plumbing, the absolute-WB `FullChainInputs`, the terminal dither,
//! and the EXIF orient — is platform-neutral and runs on Metal via
//! [`super::render_gpu_core`]. This test drives THAT core on a real (synthetic)
//! DNG and compares its u8 surface to the CPU `render_from_raw_with_quality_and_source`
//! reference — the exact pipeline `crate::render_bytes` wraps.
//!
//! The parity claim: GPU `render_bytes_gpu` ≈ CPU `render_bytes` within the web
//! per-fixture budgets. Because (a) P4b-core proved the GPU scene-linear+view+dither
//! chain matches the CPU stage subset within `< 1e-4` (→ ≤ 1 LSB post-dither),
//! and (b) this test's decode-boundary reconstruction develops the SAME upstream
//! math, the byte surfaces agree to a small max-delta + a near-zero mismatch
//! fraction. A wholesale divergence (a mismatched AE decision, a non-no-op
//! short-circuit, a wrong WB sense) blows past these thresholds — that's the gate.
//!
//! Skips (soft pass) when the synthetic DNG fixture or a Metal adapter is absent,
//! mirroring `test_color_pipeline.sh`'s "no fixtures, skipping" pattern.

use raw_core::pipeline::{render_from_raw_with_quality_and_source, RawInput, RenderQuality};
use raw_core::types::adjustment::{
    AutoExposureMode, HighlightRecoveryMode, Profile, ToneCurveMode,
};
use raw_core::types::ToneCurve;
use raw_core::view::auto_profile;
use raw_core::xmp::AdjustmentModel;

/// Resolve the committed synthetic grey DNG (a flat L=0.18 RGGB Bayer frame —
/// the same fixture the Apple grey-pipeline harness uses). Returns `None` when
/// absent so the test soft-passes. Resolved from `CARGO_MANIFEST_DIR`
/// (`src/raw-pipeline/raw-wasm`) up to the repo root.
pub(super) fn synthetic_dng_path() -> Option<std::path::PathBuf> {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    // raw-wasm → raw-pipeline → src → repo-root
    let root = manifest.parent()?.parent()?.parent()?;
    let p = root.join("src/apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng");
    p.exists().then_some(p)
}

/// Whether a Metal (or any) GPU adapter is available — guards the test so a
/// headless box with no GPU soft-passes instead of failing on
/// `GpuContext::new_async`'s "no suitable GPU adapter" error.
pub(super) fn gpu_available() -> bool {
    let instance = wgpu::Instance::default();
    pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).is_some()
}

/// The CPU reference: EXACTLY what `crate::render_bytes` produces for `model` —
/// `render_from_raw_with_quality_and_source` with the bytes source (so Auto
/// Profile, when active, fits against the embedded JPEG the same way). Returns
/// the oriented u8 RGB surface.
pub(super) fn cpu_reference(
    raw_img: &raw_core::image::RawImage,
    bytes: &[u8],
    ext: &str,
    model: &AdjustmentModel,
) -> (u32, u32, Vec<u8>) {
    render_from_raw_with_quality_and_source(
        raw_img,
        model,
        RenderQuality::Full,
        Some(RawInput::Bytes { bytes, ext }),
    )
    .expect("CPU reference render failed")
}

/// Run the GPU core (the platform-neutral body of `render_bytes_gpu`) on the host
/// via pollster and compare its u8 surface to the CPU reference. `max_delta` /
/// `frac` budgets mirror the C4 host-parity gate (`gpu_live_tests`): ≤ 1 LSB is
/// pure f32→u8 quantize-boundary noise; the fraction guard catches a real
/// divergence. Looser ceilings than C4 here only to absorb that this path runs
/// the FULL upstream develop (DCP / AE / highlight recovery) on both sides rather
/// than a hand-built scene-linear fixture, so any tiny upstream f32 nondeterminism
/// (none expected — it's deterministic) would surface as boundary pixels.
fn assert_gpu_matches_cpu(
    name: &str,
    raw_img: &raw_core::image::RawImage,
    bytes: &[u8],
    ext: &str,
    model: &AdjustmentModel,
) {
    let (cw, ch, cpu) = cpu_reference(raw_img, bytes, ext, model);
    // `None` target → the DEFAULT_TARGET_LONG_EDGE (2048) cap (#1080). The
    // synthetic fixture is 64×64, far under the cap, so the sized develop
    // no-ops and full-parity-vs-CPU continues to hold byte-for-byte.
    let (gw, gh, gpu) =
        pollster::block_on(super::render_gpu_core(raw_img, bytes, ext, model, None))
            .expect("GPU core render failed");

    assert_eq!(
        (cw, ch),
        (gw, gh),
        "[{name}] GPU dims {gw}x{gh} != CPU {cw}x{ch}"
    );
    assert_eq!(cpu.len(), gpu.len(), "[{name}] surface length mismatch");

    let max_delta = cpu
        .iter()
        .zip(&gpu)
        .map(|(a, b)| (*a as i32 - *b as i32).unsigned_abs())
        .max()
        .unwrap_or(0);
    let mismatches = cpu.iter().zip(&gpu).filter(|(a, b)| a != b).count();
    let frac = mismatches as f32 / cpu.len().max(1) as f32;
    eprintln!(
        "GPU render_bytes_gpu PARITY [{name}]: {gw}x{gh}, max byte delta = {max_delta}, \
         {mismatches} / {} bytes differ ({:.3}%)",
        cpu.len(),
        frac * 100.0
    );

    // ≤ 2 LSB: the f32 chain is < 1e-4 vs CPU and the dither is byte-identical
    // GPU-vs-CPU (C2), so the surface agrees to ≤ 1 LSB on the C4 hand-built
    // fixture; ≤ 2 here gives one extra LSB of slack for the boundary pixels the
    // real upstream develop can tip across. A wrong AE decision / WB sense /
    // non-no-op short-circuit is a WHOLESALE shift that sails past this.
    assert!(
        max_delta <= 2,
        "[{name}] GPU vs CPU max byte delta {max_delta} > 2 — beyond f32→u8 boundary noise \
         (decode-boundary or chain divergence)"
    );
    assert!(
        frac < 0.05,
        "[{name}] {:.3}% of bytes differ from CPU — too many for boundary noise (a real divergence)",
        frac * 100.0
    );
}

/// THE W1 GATE: `render_bytes_gpu`'s decode-boundary + GPU-chain reconstruction
/// matches the CPU `render_bytes` pipeline on a real DNG, for a NEUTRAL model and
/// an AGGRESSIVE one (every gated scene-linear stage engaged + a non-neutral WB +
/// a luma point curve), so the GPU re-applies real WB / tone / curves / spatial
/// passes — not just the always-on view tail. Synthetic DNG has no embedded JPEG,
/// so `profile` stays Neutral (AgX tail) on both sides; the decode-boundary,
/// absolute-WB, view-tail, dither, and orient plumbing are what's under test.
#[test]
fn render_bytes_gpu_matches_cpu_render_bytes() {
    let Some(path) = synthetic_dng_path() else {
        eprintln!("render_bytes_gpu parity: synthetic DNG fixture absent — skipping (soft pass)");
        return;
    };
    if !gpu_available() {
        eprintln!("render_bytes_gpu parity: no GPU adapter — skipping (soft pass)");
        return;
    }
    let bytes = std::fs::read(&path).expect("read synthetic DNG");
    let ext = "dng";
    let raw_img = raw_core::decode::decode_bytes(&bytes, ext).expect("decode synthetic DNG");

    // (1) Neutral model — exercises the decode boundary with WB at the no-op
    //     short-circuit (GPU's absolute WB == CPU's no-op) + the always-on view
    //     tail + dither + orient. The strictest check that flag-on == the CPU
    //     pipeline at rest.
    let neutral = AdjustmentModel::default();
    assert_gpu_matches_cpu("neutral", &raw_img, &bytes, ext, &neutral);

    // (2) Aggressive model — every gated scene-linear stage engaged so the GPU
    //     re-applies real WB / scene-tone / tone-curves / vibrance / saturation /
    //     clarity / texture / dehaze / sharpen / NR passes absolutely on the
    //     post-AE buffer. `auto_exposure: Off` (no embedded JPEG → the CPU render
    //     keeps AE ON by default; pin both sides to the same mode so the gate
    //     measures the chain, not the AE decision — that decision has its own
    //     coverage via the `auto_will_fit` probe mirror).
    let aggressive = AdjustmentModel {
        temperature: 4800.0,
        tint: 18.0,
        exposure: 0.4,
        contrast: 35.0,
        highlights: -40.0,
        shadows: 30.0,
        whites: 20.0,
        blacks: -15.0,
        parametric_shadows: 20.0,
        parametric_lights: 15.0,
        tone_curve_luma: ToneCurve::new(vec![(0.0, 0.0), (0.25, 0.18), (0.75, 0.82), (1.0, 1.0)]),
        tone_curve_mode: ToneCurveMode::RatioPreserving,
        vibrance: 35.0,
        saturation: 25.0,
        clarity: 40.0,
        texture: 30.0,
        dehaze: 45.0,
        sharpen_amount: 80.0,
        sharpen_radius: 1.5,
        sharpen_detail: 30.0,
        sharpen_masking: 20.0,
        nr_luminance: 30.0,
        nr_color: 40.0,
        auto_exposure: AutoExposureMode::Off,
        ..AdjustmentModel::default()
    };
    assert_gpu_matches_cpu("aggressive", &raw_img, &bytes, ext, &aggressive);
}

// ── Pure-logic gates (no GPU, no fixture) for the decode-boundary plumbing the
//    byte-exact end-to-end gate above does NOT exercise: the stripped-prefix
//    model shape and the `auto_will_fit` AE-decision probe (the Profile::Auto /
//    AE-Off-when-fit path — the lone wholesale-brightness risk). These run
//    everywhere, including CI without the DNG fixture or a GPU. ───────────────

/// `stripped_prefix_model` (the decode-boundary split) MUST: pin WB to the
/// 6500/0 neutral (so `white_balance::apply` no-ops and the GPU chain owns
/// absolute WB), carry the supplied AE mode, zero EVERY stage the GPU chain
/// re-runs (so develop short-circuits them bit-exactly), and PRESERVE the
/// decode-upstream fields the GPU chain does NOT do (`highlight_recovery`,
/// `capture_sharpening_*`, `profile`, `wb_method`). Mirrors raw-core's
/// `fit_develop_model_zeroes_high_freq_and_preserves_rest` in intent.
#[test]
fn stripped_prefix_model_neutralizes_rerun_and_preserves_upstream() {
    // Start from a model whose every relevant field is deliberately non-default
    // and non-zero, so a missing neutralization can't masquerade as correct.
    let full = AdjustmentModel {
        temperature: 4800.0,
        tint: 18.0,
        exposure: 1.5,
        contrast: 22.0,
        highlights: -40.0,
        shadows: 30.0,
        whites: 20.0,
        blacks: -15.0,
        parametric_shadows: 11.0,
        parametric_darks: 12.0,
        parametric_lights: 13.0,
        parametric_highlights: 14.0,
        tone_curve_luma: ToneCurve::new(vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)]),
        tone_curve_red: ToneCurve::new(vec![(0.0, 0.0), (1.0, 0.9)]),
        vibrance: 35.0,
        saturation: 25.0,
        clarity: 40.0,
        texture: 30.0,
        dehaze: 45.0,
        sharpen_amount: 80.0,
        nr_luminance: 30.0,
        nr_color: 40.0,
        // Decode-upstream fields the GPU chain does NOT run — must survive.
        highlight_recovery: HighlightRecoveryMode::Off,
        capture_sharpening_amount: 65.0,
        capture_sharpening_sigma: 1.2,
        profile: Profile::Neutral,
        auto_exposure: AutoExposureMode::On,
        ..AdjustmentModel::default()
    };

    // Pin AE Off (the value the probe would pick when Auto Profile fits).
    let s = super::stripped_prefix_model(&full, AutoExposureMode::Off);

    // (a) WB pinned to the neutral short-circuit band.
    assert_eq!(s.temperature, 6500.0, "WB temp must be pinned neutral");
    assert_eq!(s.tint, 0.0, "WB tint must be pinned neutral");

    // (b) AE mode carried through from the argument.
    assert_eq!(
        s.auto_exposure,
        AutoExposureMode::Off,
        "AE mode must come from the arg"
    );

    // (c) Every GPU-re-run stage zeroed (→ develop short-circuits it bit-exactly).
    assert_eq!(s.exposure, 0.0);
    assert_eq!(s.contrast, 0.0);
    assert_eq!(s.highlights, 0.0);
    assert_eq!(s.shadows, 0.0);
    assert_eq!(s.whites, 0.0);
    assert_eq!(s.blacks, 0.0);
    assert_eq!(s.parametric_shadows, 0.0);
    assert_eq!(s.parametric_darks, 0.0);
    assert_eq!(s.parametric_lights, 0.0);
    assert_eq!(s.parametric_highlights, 0.0);
    assert!(
        s.tone_curve_luma.points.is_empty(),
        "luma curve must be identity"
    );
    assert!(
        s.tone_curve_red.points.is_empty(),
        "red curve must be identity"
    );
    assert_eq!(s.vibrance, 0.0);
    assert_eq!(s.saturation, 0.0);
    assert_eq!(s.clarity, 0.0);
    assert_eq!(s.texture, 0.0);
    assert_eq!(s.dehaze, 0.0);
    assert_eq!(s.sharpen_amount, 0.0);
    assert_eq!(s.nr_luminance, 0.0);
    assert_eq!(s.nr_color, 0.0);

    // (d) Decode-upstream fields preserved verbatim — these shape the post-AE
    //     buffer the GPU chain consumes.
    assert_eq!(
        s.highlight_recovery,
        HighlightRecoveryMode::Off,
        "HR mode must survive the strip"
    );
    assert_eq!(
        s.capture_sharpening_amount, 65.0,
        "capture-sharpening must survive (baked in prefix)"
    );
    assert_eq!(s.capture_sharpening_sigma, 1.2);
    assert_eq!(s.profile, Profile::Neutral, "profile must survive");
    assert_eq!(s.wb_method, full.wb_method, "wb_method must survive");
}

/// `auto_will_fit` mirrors `render_bytes`'s probe: false unless `Profile::Auto`,
/// and (for Auto) true when the shared cache already holds a fit for these bytes.
/// This is the AE-pin discriminator — the lone wholesale-brightness risk — so it
/// must match the CPU render's gate. Drives it via a `cache::insert` keyed on the
/// SAME `CacheKey::from_bytes` the probe uses (no embedded JPEG needed).
///
/// raw-core's `cache::clear_for_test` is `#[cfg(test)]` and so invisible across
/// the crate boundary; instead each assertion uses DISTINCT, unique byte strings
/// (the cache is keyed by a hash of the bytes) so neither depends on a clear and
/// the order-independent process-wide static cache can't contaminate the result.
#[test]
fn auto_will_fit_matches_profile_and_cache() {
    let ext = "dng";
    // Three distinct keys so the "cold" cases stay cold no matter the run order.
    let cold_bytes = b"p4b-web-auto-will-fit-cold-key-unique-0001" as &[u8];
    let neutral_bytes = b"p4b-web-auto-will-fit-neutral-key-unique-0002" as &[u8];
    let hit_bytes = b"p4b-web-auto-will-fit-hit-key-unique-0003" as &[u8];

    // Neutral profile → never fits (short-circuits before any cache/preview probe).
    let neutral = AdjustmentModel {
        profile: Profile::Neutral,
        ..AdjustmentModel::default()
    };
    assert!(
        !super::auto_will_fit(&neutral, neutral_bytes, ext),
        "Neutral profile must not fit"
    );

    // Auto profile, cold cache (these bytes never inserted), no extractable
    // preview (garbage bytes → no embedded JPEG) → false.
    let auto = AdjustmentModel {
        profile: Profile::Auto,
        ..AdjustmentModel::default()
    };
    assert!(
        !super::auto_will_fit(&auto, cold_bytes, ext),
        "Auto with cold cache + no preview must not fit"
    );

    // Auto profile + a cache HIT on these exact bytes → true (a prior CPU/GPU
    // render fit this RAW; the probe predicts the fit without re-extracting).
    // `Full` = the quality this path's fit runs at, which is the key the
    // probe checks (#2035 quality-keyed cache).
    let key = auto_profile::cache::CacheKey::from_bytes(hit_bytes, RenderQuality::Full);
    auto_profile::cache::insert(key, auto_profile::curve::ProfileCurve::identity());
    assert!(
        super::auto_will_fit(&auto, hit_bytes, ext),
        "Auto with a curve cached for these bytes must fit (AE → Off)"
    );
}

// ── #1038 persistent-session boundary proof (the re-develop / re-upload trigger).
//
// `WebLiveSession::render` re-develops + re-uploads ONLY when the stripped-prefix
// model changes. For the persistence win to hold, every HOT-PATH slider (the ones
// `build_full_chain_inputs` feeds the GPU chain) MUST leave the prefix model
// unchanged, and every GENUINE prefix field MUST change it. The prefix model is
// `stripped_prefix_model(model, ae_mode)` — so these gates pin exactly the
// `..full.clone()` zeroing invariant that, if wrong, silently turns the fast path
// into a per-tick re-upload (correctness held, perf lost). No GPU / fixture needed,
// so this runs in CI everywhere. ──────────────────────────────────────────────

/// A model with EVERY hot-path GPU-chain slider set to a distinct non-default
/// value, so a missing neutralization in `stripped_prefix_model` surfaces as a
/// prefix-model inequality below.
fn aggressive_gpu_chain_model() -> AdjustmentModel {
    AdjustmentModel {
        // WB (absolute, applied on the GPU) + every scene-linear + view-tail slider.
        temperature: 4800.0,
        tint: 18.0,
        wb_method: raw_core::types::WbMethod::DiagonalRec2020,
        exposure: 0.4,
        contrast: 35.0,
        highlights: -40.0,
        shadows: 30.0,
        whites: 20.0,
        blacks: -15.0,
        parametric_highlights: 14.0,
        parametric_lights: 13.0,
        parametric_darks: 12.0,
        parametric_shadows: 11.0,
        tone_curve_luma: ToneCurve::new(vec![(0.0, 0.0), (0.5, 0.6), (1.0, 1.0)]),
        tone_curve_red: ToneCurve::new(vec![(0.0, 0.0), (1.0, 0.9)]),
        tone_curve_mode: ToneCurveMode::RatioPreserving,
        vibrance: 35.0,
        saturation: 25.0,
        clarity: 40.0,
        texture: 30.0,
        dehaze: 45.0,
        sharpen_amount: 80.0,
        sharpen_radius: 2.5,
        sharpen_detail: 60.0,
        sharpen_masking: 20.0,
        nr_luminance: 30.0,
        nr_color: 40.0,
        ..AdjustmentModel::default()
    }
}

/// THE #1038 BOUNDARY GATE: with the effective AE mode fixed, the stripped-prefix
/// model is IDENTICAL for the default model and a model with EVERY hot-path
/// GPU-chain slider cranked — i.e. no hot-path slider leaks into the prefix. This
/// is what keeps a WB/tone/sharpen-radius/curve-mode tick on the zero-re-upload
/// fast path. (Had `stripped_prefix_model` forgotten to neutralize, say,
/// `sharpen_radius`, this gate would fail — the exact bug class the persistence
/// claim depends on not having.)
#[test]
fn stripped_prefix_invariant_to_gpu_chain_sliders() {
    // Fix the AE mode so this isolates the field-leak question from the AE probe.
    let ae = AutoExposureMode::On;
    let base = super::stripped_prefix_model(&AdjustmentModel::default(), ae);
    let cranked = super::stripped_prefix_model(&aggressive_gpu_chain_model(), ae);
    assert_eq!(
        base, cranked,
        "a hot-path GPU-chain slider leaked into the stripped-prefix model — the persistent \
         session would spuriously re-develop + re-upload every tick. Neutralize it in \
         stripped_prefix_model (it is inert in the prefix: its parent stage is zeroed/pinned)."
    );
}

/// The complement: each GENUINE prefix field (the decode-upstream stages the GPU
/// chain does NOT re-run, plus the AE mode) DOES change the prefix model — so a
/// real prefix edit correctly re-develops. Guards against an over-aggressive
/// neutralization that would wrongly pin the fast path and render a stale buffer.
#[test]
fn stripped_prefix_changes_on_genuine_prefix_edits() {
    let ae = AutoExposureMode::On;
    let base = super::stripped_prefix_model(&AdjustmentModel::default(), ae);

    // (a) AE mode (the `auto_will_fit` probe pins this; a profile/cache change that
    //     flips it MUST re-develop, since AE shapes the post-AE buffer).
    let ae_off = super::stripped_prefix_model(&AdjustmentModel::default(), AutoExposureMode::Off);
    assert_ne!(base, ae_off, "AE-mode change must re-develop the prefix");

    // (b) capture_sharpening (baked in the prefix at its canonical position).
    let cs = super::stripped_prefix_model(
        &AdjustmentModel {
            capture_sharpening_amount: 65.0,
            ..AdjustmentModel::default()
        },
        ae,
    );
    assert_ne!(
        base, cs,
        "capture-sharpening change must re-develop the prefix"
    );

    // (c) highlight_recovery (a decode-upstream stage the GPU chain does not run).
    let hr = super::stripped_prefix_model(
        &AdjustmentModel {
            highlight_recovery: HighlightRecoveryMode::Off,
            ..AdjustmentModel::default()
        },
        ae,
    );
    // Only asserts difference when Off != the default mode; if equal, skip the claim.
    if AdjustmentModel::default().highlight_recovery != HighlightRecoveryMode::Off {
        assert_ne!(
            base, hr,
            "highlight-recovery change must re-develop the prefix"
        );
    }

    // (d) profile (kept in the prefix; an Auto↔Neutral flip also flips the AE
    //     decision upstream, so the prefix legitimately differs).
    let prof = super::stripped_prefix_model(
        &AdjustmentModel {
            profile: Profile::Neutral,
            ..AdjustmentModel::default()
        },
        ae,
    );
    if AdjustmentModel::default().profile != Profile::Neutral {
        assert_ne!(base, prof, "profile change must re-develop the prefix");
    }
}

/// GPU ZERO-ALLOC on the f32 / PRESENT path (`render_chain_to_f32`), which the
/// persistent `WebLiveSession` drives every tick — the surface present samples the
/// resident f32 buffer this leaves, so it never reads back. `live_session/tests.rs`
/// gates this on `render_to_buffer` (the u8 readback path); this fills the gap for
/// the f32 path #1038 actually uses: a 2nd render at the SAME chain signature must
/// allocate ZERO new pooled GPU resources (the CLAUDE.md render-loop invariant).
///
/// "No pipeline RECOMPILE" is structural, not counted here: `GpuContext` (its ~35
/// `OnceCell` compute pipelines) and `WebPresentSurface` (the present pipeline) are
/// each built ONCE in `WebLiveSession::open` and reused — `pool_alloc_count` tracks
/// pooled bind-groups/uniforms/scratch, not the compile-once `OnceCell`s.
///
/// Soft-passes without a GPU adapter. Uses a hand-built scene-linear buffer (no RAW
/// fixture needed) — the zero-alloc property is about GPU resource reuse, not pixel
/// values, so a synthetic upload exercises it fully.
#[test]
fn render_chain_to_f32_second_render_is_zero_alloc() {
    use raw_gpu::{
        CancelToken, CurveMode, FullChainInputs, GpuContext, LiveSession, ToneCurveInputs,
    };
    if !gpu_available() {
        eprintln!("render_chain_to_f32 zero-alloc: no GPU adapter — skipping (soft pass)");
        return;
    }

    let (w, h) = (16u32, 12u32);
    let mut rgba = Vec::with_capacity((w * h) as usize * 4);
    for i in 0..(w * h) as usize {
        let t = i as f32 / ((w * h) as f32 - 1.0);
        rgba.extend_from_slice(&[t * 0.8, t * 0.5 + 0.1, t * 0.3 + 0.2, 1.0]);
    }

    let ctx = GpuContext::new_blocking().expect("gpu context");
    let session = LiveSession::new(&ctx, &rgba, w, h).expect("session");
    // A neutral-ish chain (dehaze inactive → the single-submit f32 path the present
    // uses). Default inputs keep the signature stable across the two renders.
    let inputs = FullChainInputs {
        wb_matrix: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        wb_temperature: 6500.0,
        wb_tint: 0.0,
        tone: [0.0; 6],
        tone_curves: ToneCurveInputs {
            parametric: [0.0; 4],
            luma: vec![],
            red: vec![],
            green: vec![],
            blue: vec![],
            mode: CurveMode::PerChannel,
        },
        vibrance: 0.0,
        saturation: 0.0,
        clarity: 0.0,
        texture: 0.0,
        dehaze: 0.0,
        vignette_amount: 0.0,
        vignette_feather: 50.0,
        grain_amount: 0.0,
        grain_size: 25.0,
        grain_roughness: 50.0,
        split_tone_shadow_hue: 0.0,
        split_tone_shadow_saturation: 0.0,
        split_tone_highlight_hue: 0.0,
        split_tone_highlight_saturation: 0.0,
        split_tone_balance: 0.0,
        hsl_hue: [0.0; 8],
        hsl_sat: [0.0; 8],
        hsl_lum: [0.0; 8],
        sharpen_amount: 0.0,
        sharpen_radius: 1.0,
        sharpen_detail: 25.0,
        sharpen_masking: 0.0,
        nr_luminance: 0.0,
        nr_color: 0.0,
        contrast: 0.0,
        capture_sharpening: None,
        profile_curve_flat: auto_profile::curve::ProfileCurve::identity().to_flat(),
        residual_lut_size: auto_profile::lut::ColorLut::identity(auto_profile::DEFAULT_LUT_SIZE)
            .size,
        residual_lut_data: auto_profile::lut::ColorLut::identity(auto_profile::DEFAULT_LUT_SIZE)
            .data,
        // sRGB primaries — the default (#1337).
        target_primaries: 0,
        // Web test always uses the RAW / full chain.
        input_shape: raw_gpu::InputShape::PostDcpRec2020Fp16,
        // AgX (default) — no profile selection in this test (#1722).
        profile_id: 0,
    };
    let cancel = CancelToken::new();

    let before_first = session.pool_alloc_count(&ctx);
    let idx1 = session
        .render_chain_to_f32(&ctx, &inputs, &cancel)
        .expect("first chain-to-f32 render ok")
        .expect("first chain-to-f32 render");
    let first_allocs = session.pool_alloc_count(&ctx) - before_first;

    let idx2 = session
        .render_chain_to_f32(&ctx, &inputs, &cancel)
        .expect("second chain-to-f32 render ok")
        .expect("second chain-to-f32 render");
    let second_allocs = session.pool_alloc_count(&ctx) - before_first - first_allocs;

    eprintln!(
        "render_chain_to_f32 zero-alloc: first render allocated {first_allocs} pooled resources, \
         second allocated {second_allocs} (final idx {idx1} then {idx2})"
    );
    assert_eq!(
        second_allocs, 0,
        "a 2nd same-signature render_chain_to_f32 allocated {second_allocs} pooled GPU resources \
         — the present path's render loop is not zero-alloc"
    );
}
