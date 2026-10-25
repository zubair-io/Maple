//! The capture-first Web live path (#5379): the capture decode the
//! `WebLiveSession` uploads, rendered by the creative stage the session holds.
//!
//! - Live vs refine: the GPU chain over the capture decode against the Web
//!   CPU refine (`render_from_raw_with_auto_fit` at the same cap, what
//!   `CpuLiveSession` runs), within one 8-bit step on every channel, over
//!   S3a's matrix: as-shot, ±800 K, 2000 K and 50000 K plus the unedited
//!   photo, across deep denoise, chroma prefilter, retouch, capture
//!   sharpening, Oklab recovery and auto exposure, through the session's own
//!   tick path. Fixture-gated (`--ignored`), with a synthetic-DNG subset that
//!   always runs. The Neutral profile, as in S3a: under Auto the sized CPU
//!   refine already differed from the live session by up to 28 steps before
//!   the capture decode, by the same amount after it.
//! - The white-balance tick allocates nothing on the host and no pooled GPU
//!   resource after its first frame.

use super::tests::gpu_available;
use super::{chain_inputs_with_status, develop_capture_prefix_rgba};
use raw_core::gpu_host::live_profile::LiveProfile;
use raw_core::pipeline::{render_from_raw_with_auto_fit, RawInput, RenderQuality};
use raw_core::types::adjustment::AutoExposureMode;
use raw_core::types::local_adjustment::Point2;
use raw_core::types::{RetouchKind, RetouchSpot};
use raw_core::xmp::{AdjustmentModel, HighlightRecoveryMode, Profile};
use raw_gpu::{GpuContext, LiveSession};

const EDGE: u32 = 512;

fn base() -> AdjustmentModel {
    AdjustmentModel {
        profile: Profile::Neutral,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..AdjustmentModel::default()
    }
}

fn combinations() -> Vec<(&'static str, AdjustmentModel)> {
    let spot = RetouchSpot {
        kind: RetouchKind::Heal,
        center: Point2::new(0.42, 0.4),
        source: Point2::new(0.62, 0.58),
        radius: 0.06,
        feather: 0.4,
        opacity: 1.0,
    };
    let every_stage = AdjustmentModel {
        chroma_prefilter: 60.0,
        deep_denoise: 50.0,
        retouch_spots: vec![spot],
        capture_sharpening_amount: 80.0,
        highlight_recovery: HighlightRecoveryMode::OklabChromaReduction,
        ..base()
    };
    vec![
        ("plain", base()),
        (
            "chroma",
            AdjustmentModel {
                chroma_prefilter: 60.0,
                ..base()
            },
        ),
        (
            "denoise",
            AdjustmentModel {
                deep_denoise: 50.0,
                ..base()
            },
        ),
        (
            "retouch",
            AdjustmentModel {
                retouch_spots: vec![spot],
                ..base()
            },
        ),
        (
            "sharpening",
            AdjustmentModel {
                capture_sharpening_amount: 80.0,
                ..base()
            },
        ),
        (
            "oklab-recovery",
            AdjustmentModel {
                highlight_recovery: HighlightRecoveryMode::OklabChromaReduction,
                ..base()
            },
        ),
        (
            "ae-off",
            AdjustmentModel {
                auto_exposure: AutoExposureMode::Off,
                ..base()
            },
        ),
        ("every-stage", every_stage.clone()),
        (
            "every-stage-ae-off",
            AdjustmentModel {
                auto_exposure: AutoExposureMode::Off,
                ..every_stage
            },
        ),
    ]
}

/// The live frame for `model` through the session's own tick path
/// (`LiveProfile::update`, then the creative stage), read back and oriented
/// as the one-shot `render_bytes_gpu` does.
fn live(
    ctx: &GpuContext,
    raw: &raw_core::RawImage,
    prefix: &super::CapturePrefix,
    session: &LiveSession,
    profile: &mut LiveProfile,
    model: &AdjustmentModel,
) -> (u32, u32, Vec<u8>) {
    profile.update(model);
    prefix
        .creative
        .apply(model, &mut profile.inputs)
        .expect("creative");
    profile.inputs.nr_sampling_scale = prefix.nr_sampling_scale;
    let rgb = pollster::block_on(session.render_async(ctx, &profile.inputs, None))
        .expect("live render")
        .expect("live frame");
    raw_core::image::apply_orientation(&rgb, prefix.width, prefix.height, raw.orientation)
}

/// The slider pairs a drag visits, plus the unedited photo (`6500/0`, unseen).
fn targets(prefix: &super::CapturePrefix) -> Vec<(&'static str, Option<(f32, f32)>)> {
    let (cct, tint) = prefix
        .creative
        .header
        .frame
        .map_or((6500.0, 0.0), |f| (f.scene_cct, f.scene_tint));
    vec![
        ("unedited", None),
        ("as-shot", Some((cct, tint))),
        ("+800K", Some((cct + 800.0, tint))),
        ("-800K", Some((cct - 800.0, tint))),
        ("2000K", Some((2000.0, tint))),
        ("50000K", Some((50000.0, tint))),
    ]
}

/// The worst 8-bit step between the live frame and the Web CPU refine over
/// every combination and target; asserts each is at most one.
fn gate(
    name: &str,
    bytes: &[u8],
    ext: &str,
    edge: u32,
    combinations: Vec<(&'static str, AdjustmentModel)>,
) -> u8 {
    let raw = raw_core::decode::decode_bytes(bytes, ext).expect("decode fixture");
    let ctx = GpuContext::new_blocking().expect("GPU context");
    combinations
        .into_iter()
        .flat_map(|(combination, decode_model)| {
            let prefix = develop_capture_prefix_rgba(&raw, bytes, ext, &decode_model, edge)
                .expect("capture decode");
            let session = LiveSession::new(&ctx, &prefix.rgba, prefix.width, prefix.height)
                .expect("session upload");
            let mut profile = LiveProfile::new(
                &raw,
                bytes,
                ext,
                &decode_model,
                None,
                0,
                prefix.whites_anchor_ev,
            );
            targets(&prefix)
                .into_iter()
                .map(|(target, pair)| {
                    let model = pair.map_or_else(
                        || decode_model.clone(),
                        |(temperature, tint)| AdjustmentModel {
                            temperature,
                            tint,
                            temperature_seen: true,
                            tint_seen: true,
                            ..decode_model.clone()
                        },
                    );
                    let (lw, lh, shown) = live(&ctx, &raw, &prefix, &session, &mut profile, &model);
                    let (rw, rh, refined, _) = render_from_raw_with_auto_fit(
                        &raw,
                        &model,
                        RenderQuality::Amaze,
                        Some(RawInput::Bytes { bytes, ext }),
                        Some(edge),
                        None,
                    )
                    .expect("refine");
                    assert_eq!((lw, lh), (rw, rh), "{name} [{combination}] dims");
                    let step = shown
                        .iter()
                        .zip(&refined)
                        .map(|(a, b)| a.abs_diff(*b))
                        .max()
                        .unwrap_or(0);
                    let moved = shown.iter().zip(&refined).filter(|(a, b)| a != b).count();
                    eprintln!(
                        "{name} [{combination} @ {target}] live vs refine: max step {step}, \
                         {moved}/{} channels differ",
                        shown.len()
                    );
                    assert!(step <= 1, "{name} [{combination} @ {target}]: {step} steps");
                    step
                })
                .collect::<Vec<_>>()
        })
        .max()
        .unwrap_or(0)
}

fn fixture_gate(name: &str) {
    if !gpu_available() {
        eprintln!("{name}: no GPU adapter — skipping (soft pass)");
        return;
    }
    let path = raw_core::test_support::fixtures::require_raw(name);
    let bytes = std::fs::read(&path).expect("read fixture");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("dng")
        .to_ascii_lowercase();
    let worst = gate(name, &bytes, &ext, EDGE, combinations());
    eprintln!("{name}: worst live-vs-refine step {worst}");
}

#[test]
#[ignore = "needs test-fixtures/raws/test_0005.RAF (gitignored) and a GPU; run with --ignored"]
fn live_matches_refine_within_one_step_on_test_0005() {
    fixture_gate("test_0005.RAF");
}

#[test]
#[ignore = "needs test-fixtures/raws/test_0007.DNG (gitignored) and a GPU; run with --ignored"]
fn live_matches_refine_within_one_step_on_test_0007() {
    fixture_gate("test_0007.DNG");
}

/// The same gate on the generated grey DNG, so CI runs it without the
/// gitignored fixtures.
#[test]
fn live_matches_refine_within_one_step_on_a_synthetic_dng() {
    if !gpu_available() {
        eprintln!("synthetic live-vs-refine: no GPU adapter — skipping (soft pass)");
        return;
    }
    let bytes = raw_core::test_support::synth_dng::SyntheticGreyDng {
        width: 64,
        height: 64,
        ..Default::default()
    }
    .write_to_bytes();
    let selected = combinations()
        .into_iter()
        .filter(|(combination, _)| matches!(*combination, "plain" | "ae-off" | "oklab-recovery"))
        .collect();
    gate("synthetic", &bytes, "dng", 64, selected);
}

/// A white-balance drag rebuilds only the creative plan: no host allocation
/// per tick, no new pooled GPU resource after the first frame, and the frame
/// does move with the slider.
#[test]
fn white_balance_drag_allocates_nothing() {
    let bytes = raw_core::test_support::synth_dng::SyntheticGreyDng {
        width: 64,
        height: 64,
        ..Default::default()
    }
    .write_to_bytes();
    let raw = raw_core::decode::decode_bytes(&bytes, "dng").expect("decode synthetic DNG");
    let model = base();
    let prefix = develop_capture_prefix_rgba(&raw, &bytes, "dng", &model, 64).expect("capture");
    let (mut inputs, _) = chain_inputs_with_status(
        &raw,
        &bytes,
        "dng",
        &model,
        None,
        0,
        prefix.whites_anchor_ev,
    );
    prefix
        .creative
        .apply(&model, &mut inputs)
        .expect("creative");
    let gpu = gpu_available().then(|| {
        let ctx = GpuContext::new_blocking().expect("GPU context");
        let session =
            LiveSession::new(&ctx, &prefix.rgba, prefix.width, prefix.height).expect("session");
        (ctx, session)
    });
    let cancel = raw_gpu::CancelToken::new();
    let first = gpu.as_ref().map(|(ctx, session)| {
        let frame = session.render_to_buffer(ctx, &inputs, &cancel).unwrap();
        (frame, session.pool_alloc_count(ctx))
    });
    let mut moved = false;
    for (temperature, tint) in [(3200.0, -10.0), (5000.0, 0.0), (9000.0, 25.0)] {
        let tick = AdjustmentModel {
            temperature,
            tint,
            temperature_seen: true,
            tint_seen: true,
            ..model.clone()
        };
        let count = super::tests_zero_alloc::allocations::count(|| {
            raw_core::gpu_host::model::update_chain_inputs(&tick, &mut inputs);
            prefix.creative.apply(&tick, &mut inputs).unwrap();
        });
        assert_eq!(count, 0, "a white-balance tick allocated on the host");
        assert!(inputs.creative.is_some() && inputs.wb_hsm.is_none());
        if let (Some((ctx, session)), Some((frame, allocs))) = (&gpu, &first) {
            session
                .render_chain_to_f32(ctx, &inputs, &cancel)
                .unwrap()
                .unwrap();
            assert_eq!(session.pool_alloc_count(ctx), *allocs, "GPU pool grew");
            moved |= session.render_to_buffer(ctx, &inputs, &cancel).unwrap() != *frame;
        }
    }
    assert!(
        gpu.is_none() || moved,
        "white balance never changed the frame"
    );
}
