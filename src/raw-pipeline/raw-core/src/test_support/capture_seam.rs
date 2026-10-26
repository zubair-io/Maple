//! The S3 live-vs-refine matrix of the capture-first live chain (#5213),
//! shared by the Rust GPU hosts' gates (#5380) so Android and Linux cover the
//! same cases raw-ffi's `gpu_live_capture_seam_tests` covers for Apple: deep
//! denoise, chroma prefilter, retouch, capture sharpening, Oklab recovery and
//! auto exposure, each at the as-shot white balance, ±800 K, 2000 K and
//! 50000 K.
use crate::pipeline::CreativeHeader;
use crate::types::adjustment::AutoExposureMode;
use crate::types::local_adjustment::Point2;
use crate::types::{Profile, RetouchKind, RetouchSpot};
use crate::xmp::{AdjustmentModel, HighlightRecoveryMode};

/// The fixtures the gate runs on.
pub const FIXTURES: [&str; 2] = ["test_0005.RAF", "test_0007.DNG"];

/// A sidecar selecting the Neutral profile and nothing else.
pub const NEUTRAL_XMP: &str = "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:Profile=\"Neutral\"/>";

/// The long edge the gate decodes at.
pub const EDGE: u32 = 512;

/// The decode-level combinations, white balance unauthored. The tail is
/// neutral (no output sharpening or noise reduction, Neutral profile) so the
/// gate measures the capture decode and its creative stage. Auto is left out:
/// the live sessions fit it on the standalone proxy while a sized develop fits
/// it on its own render (`render_fit_origin`), so the two tails differ before
/// any capture-first stage runs.
pub fn combinations() -> Vec<(&'static str, AdjustmentModel)> {
    let base = AdjustmentModel {
        profile: Profile::Neutral,
        sharpen_amount: 0.0,
        nr_color: 0.0,
        nr_luminance: 0.0,
        ..AdjustmentModel::default()
    };
    let spot = RetouchSpot {
        kind: RetouchKind::Heal,
        center: Point2::new(0.42, 0.4),
        source: Point2::new(0.62, 0.58),
        radius: 0.06,
        feather: 0.4,
        opacity: 1.0,
    };
    let with = |edit: fn(&mut AdjustmentModel)| {
        let mut model = base.clone();
        edit(&mut model);
        model
    };
    let every_stage = AdjustmentModel {
        chroma_prefilter: 60.0,
        deep_denoise: 50.0,
        retouch_spots: vec![spot],
        capture_sharpening_amount: 80.0,
        highlight_recovery: HighlightRecoveryMode::OklabChromaReduction,
        ..base.clone()
    };
    vec![
        ("plain", base.clone()),
        ("chroma", with(|m| m.chroma_prefilter = 60.0)),
        ("denoise", with(|m| m.deep_denoise = 50.0)),
        (
            "retouch",
            AdjustmentModel {
                retouch_spots: vec![spot],
                ..base.clone()
            },
        ),
        ("sharpening", with(|m| m.capture_sharpening_amount = 80.0)),
        (
            "oklab-recovery",
            with(|m| m.highlight_recovery = HighlightRecoveryMode::OklabChromaReduction),
        ),
        ("ae-off", with(|m| m.auto_exposure = AutoExposureMode::Off)),
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

/// The white balances a drag visits, in the decode's slider frame.
pub fn targets(header: &CreativeHeader) -> Vec<(&'static str, (f32, f32))> {
    let frame = header.frame.expect("a calibrated body");
    let (cct, tint) = (frame.scene_cct, frame.scene_tint);
    vec![
        ("as-shot", (cct, tint)),
        ("+800K", (cct + 800.0, tint)),
        ("-800K", (cct - 800.0, tint)),
        ("2000K", (2000.0, tint)),
        ("50000K", (50000.0, tint)),
    ]
}

/// `model` at the authored white balance `(temperature, tint)`.
pub fn at(model: &AdjustmentModel, (temperature, tint): (f32, f32)) -> AdjustmentModel {
    AdjustmentModel {
        temperature,
        tint,
        temperature_seen: true,
        tint_seen: true,
        ..model.clone()
    }
}

/// The largest per-channel difference between two 8-bit renders.
pub fn max_step(a: &[u8], b: &[u8]) -> u8 {
    assert_eq!(a.len(), b.len(), "renders differ in size");
    a.iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}
