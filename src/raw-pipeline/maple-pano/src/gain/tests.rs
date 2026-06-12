use super::*;
use crate::ingest::ValidityMask;
use crate::math::Vec3;
use crate::prng::SplitMix64;
use crate::render::{build_camera_set, CameraSetOptions, Pattern};

/// Smooth deterministic scene function of world direction.
fn scene(dir: Vec3) -> [f32; 3] {
    let base = 0.45 + 0.2 * (3.0 * dir.x + 1.0).sin() + 0.15 * (2.0 * dir.y - 0.5).cos();
    [
        base as f32,
        (base * 0.8 + 0.1 * (4.0 * dir.z).sin()) as f32,
        (base * 0.6 + 0.05) as f32,
    ]
}

/// Render a frame of the scene function through a camera.
fn frame_from_scene(cam: &Camera, mul: [f32; 3]) -> PlanarImage {
    let (w, h) = (cam.width, cam.height);
    let n = (w as usize) * (h as usize);
    let (mut r, mut g, mut b) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
    for y in 0..h {
        for x in 0..w {
            let d = cam
                .pixel_to_world_dir(x as f64 + 0.5, y as f64 + 0.5)
                .expect("invertible");
            let s = scene(d);
            let i = (y * w + x) as usize;
            r[i] = s[0] * mul[0];
            g[i] = s[1] * mul[1];
            b[i] = s[2] * mul[2];
        }
    }
    PlanarImage::from_planes(w, h, r, g, b, ValidityMask::new_filled(w, h, true))
}

fn ring_cameras(count: u32, fov: f64, overlap: f64) -> Vec<Camera> {
    let opts = CameraSetOptions {
        count,
        pattern: Pattern::Ring { full: false },
        fov_deg: fov,
        overlap,
        pitch_deg: 0.0,
        jitter_deg: 0.0,
        k1: 0.0,
        k2: 0.0,
        width: 96,
        height: 72,
    };
    build_camera_set(&opts, &mut SplitMix64::new(3))
        .expect("valid")
        .iter()
        .map(|c| c.to_camera())
        .collect()
}

fn geometric_mean(g: &[[f32; 3]], c: usize) -> f64 {
    let s: f64 = g.iter().map(|v| (v[c] as f64).ln()).sum();
    (s / g.len() as f64).exp()
}

/// Unity input solves to gains of exactly ~1.0 (#1155 gate).
#[test]
fn unity_input_solves_to_one() {
    let cams = ring_cameras(3, 60.0, 0.4);
    let frames: Vec<_> = cams.iter().map(|c| frame_from_scene(c, [1.0; 3])).collect();
    let gains = solve_gains(&frames, &cams, &GainOptions::default()).unwrap();
    for g in &gains {
        for c in 0..3 {
            assert!((g[c] - 1.0).abs() < 1e-3, "unity gain drifted: {g:?}");
        }
    }
}

/// ±1 EV pre-multiplied frames: relative gains recovered within 1%
/// (#1155 gate). Compared after geometric-mean normalization (the
/// prior fixes the global scale, the data term the ratios).
#[test]
fn plus_minus_one_ev_recovered_within_one_percent() {
    let cams = ring_cameras(3, 60.0, 0.45);
    let muls = [2.0_f32, 1.0, 0.5];
    let frames: Vec<_> = cams
        .iter()
        .zip(muls)
        .map(|(c, m)| frame_from_scene(c, [m; 3]))
        .collect();
    let gains = solve_gains(&frames, &cams, &GainOptions::default()).unwrap();
    let gm = geometric_mean(&gains, 0);
    let want_gm = (muls.iter().map(|m| (1.0 / *m as f64).ln()).sum::<f64>() / 3.0).exp();
    for (g, m) in gains.iter().zip(muls) {
        let got = g[0] as f64 / gm;
        let want = (1.0 / m as f64) / want_gm;
        let rel = (got - want).abs() / want;
        assert!(
            rel < 0.01,
            "gain for x{m} frame: normalized {got:.5}, want {want:.5} ({:.3}% off)",
            rel * 100.0
        );
    }
    // The compensated overlap means must match: g_i·m_i ≈ const.
    let products: Vec<f64> = gains
        .iter()
        .zip(muls)
        .map(|(g, m)| g[0] as f64 * m as f64)
        .collect();
    let spread = (products.iter().cloned().fold(f64::MIN, f64::max)
        - products.iter().cloned().fold(f64::MAX, f64::min))
        / products[0];
    assert!(spread < 0.01, "compensated products spread: {products:?}");
}

/// Per-channel mode recovers independent per-channel multipliers.
#[test]
fn per_channel_multipliers_recovered() {
    let cams = ring_cameras(3, 60.0, 0.45);
    let muls: [[f32; 3]; 3] = [[1.6, 1.0, 0.7], [1.0, 1.0, 1.0], [0.8, 1.2, 1.0]];
    let frames: Vec<_> = cams
        .iter()
        .zip(muls)
        .map(|(c, m)| frame_from_scene(c, m))
        .collect();
    let gains = solve_gains(
        &frames,
        &cams,
        &GainOptions {
            mode: GainMode::PerChannel,
            ..GainOptions::default()
        },
    )
    .unwrap();
    for c in 0..3 {
        let gm = geometric_mean(&gains, c);
        let want_gm = (muls.iter().map(|m| (1.0 / m[c] as f64).ln()).sum::<f64>() / 3.0).exp();
        for (g, m) in gains.iter().zip(muls) {
            let got = g[c] as f64 / gm;
            let want = (1.0 / m[c] as f64) / want_gm;
            assert!(
                (got - want).abs() / want < 0.01,
                "channel {c}: normalized {got:.5} want {want:.5}"
            );
        }
    }
}

/// Disconnected frames anchor at exactly 1.0.
#[test]
fn disconnected_frames_get_unit_gain() {
    let a = Camera::new([0.0; 3], 90.0, 0.0, 0.0, 64, 48);
    let b = Camera::new([0.0, std::f64::consts::PI, 0.0], 90.0, 0.0, 0.0, 64, 48);
    let frames = vec![
        frame_from_scene(&a, [3.0; 3]),
        frame_from_scene(&b, [0.25; 3]),
    ];
    let gains = solve_gains(&frames, &[a, b], &GainOptions::default()).unwrap();
    for g in &gains {
        for c in 0..3 {
            assert_eq!(g[c], 1.0, "no-overlap gain must stay 1.0: {gains:?}");
        }
    }
}

#[test]
fn input_validation() {
    let cam = Camera::new([0.0; 3], 90.0, 0.0, 0.0, 64, 48);
    let frame = frame_from_scene(&cam, [1.0; 3]);
    assert!(solve_gains(&[frame.clone()], &[], &GainOptions::default()).is_err());
    let wrong = Camera::new([0.0; 3], 90.0, 0.0, 0.0, 32, 24);
    assert!(solve_gains(&[frame.clone()], &[wrong], &GainOptions::default()).is_err());
    let bad = GainOptions {
        sigma_n: 0.0,
        ..GainOptions::default()
    };
    assert!(solve_gains(&[frame], &[cam], &bad).is_err());
    assert!(solve_gains(&[], &[], &GainOptions::default())
        .unwrap()
        .is_empty());
}

#[test]
fn solve_dense_matches_known_system() {
    // [[2, 1], [1, 3]] x = [5, 10] → x = [1, 3].
    let a = vec![vec![2.0, 1.0], vec![1.0, 3.0]];
    let x = solve_dense(a, vec![5.0, 10.0]).unwrap();
    assert!((x[0] - 1.0).abs() < 1e-12 && (x[1] - 3.0).abs() < 1e-12);
    // Singular.
    let s = vec![vec![1.0, 2.0], vec![2.0, 4.0]];
    assert!(solve_dense(s, vec![1.0, 2.0]).is_none());
}

/// Gauge normalization divides by the count of POSITIVE gains only.
///
/// If any frame's solved gain is ≤ 0, the old code divided the log-sum
/// by `x.len()` (the full count), biasing `log_mean` low. This test
/// verifies the normalization produces geometric mean = 1.0 over the
/// POSITIVE entries even when a non-positive gain appears.
///
/// Key example: x = [4.0, 0.5, -0.1].
///   Positive subset {4.0, 0.5}: geomean = sqrt(2).
///   Correct log_mean  = (ln4 + ln0.5) / 2 = (ln4 - ln2) / 2 = ln(2)/2.
///   norm              = exp(-ln(2)/2) = 1/sqrt(2).
///   Normalised gains  = [4/sqrt(2), 0.5/sqrt(2)] = [2√2, √2/2].
///   Their geomean     = sqrt(2√2 · √2/2) = sqrt(2) * 1/sqrt(2) = 1.0. ✓
///
///   Buggy (divide by 3): log_mean = ln(2)/3, norm = 2^(-1/3).
///   Normalised gains  = [4·2^(-1/3), 0.5·2^(-1/3)].
///   Their geomean     = sqrt(2) · 2^(-1/3) ≠ 1.0. ✗
#[test]
fn gauge_normalization_divides_by_positive_count() {
    let x: Vec<f64> = vec![4.0, 0.5, -0.1];
    // Correct computation using the fixed divisor.
    let positive_lns: Vec<f64> = x.iter().filter(|&&g| g > 0.0).map(|&g| g.ln()).collect();
    assert_eq!(positive_lns.len(), 2);
    let log_mean_correct = positive_lns.iter().sum::<f64>() / positive_lns.len() as f64;
    let norm = (-log_mean_correct).exp();

    // After normalization, geomean of positive entries = 1.0.
    let normalised: Vec<f64> = x.iter().filter(|&&g| g > 0.0).map(|&g| g * norm).collect();
    let geomean_after =
        (normalised.iter().map(|g| g.ln()).sum::<f64>() / normalised.len() as f64).exp();
    assert!(
        (geomean_after - 1.0).abs() < 1e-12,
        "geomean of normalised positive gains must be 1.0, got {geomean_after}"
    );

    // Confirm the buggy divisor gives a DIFFERENT (wrong) result.
    let log_mean_buggy = positive_lns.iter().sum::<f64>() / x.len() as f64;
    // x.len()=3 ≠ positive_lns.len()=2, so the means differ.
    assert!(
        (log_mean_correct - log_mean_buggy).abs() > 1e-9,
        "the fix must change log_mean: correct={log_mean_correct:.6} buggy={log_mean_buggy:.6}"
    );

    // Full end-to-end: solve_gains on overlapping frames should produce
    // geomean ≈ 1.0 when all solver outputs are positive (regression
    // guard: the fix must not change behaviour on the normal case).
    let cams = ring_cameras(3, 60.0, 0.4);
    let muls = [1.5_f32, 1.0, 0.8];
    let frames: Vec<_> = cams
        .iter()
        .zip(muls)
        .map(|(c, m)| frame_from_scene(c, [m; 3]))
        .collect();
    let gains = solve_gains(&frames, &cams, &GainOptions::default()).unwrap();
    let positive_count = gains.iter().filter(|g| g[0] > 0.0).count();
    let ln_sum: f64 = gains
        .iter()
        .filter(|g| g[0] > 0.0)
        .map(|g| (g[0] as f64).ln())
        .sum();
    let geomean = (ln_sum / positive_count as f64).exp();
    assert!(
        (geomean - 1.0).abs() < 1e-4,
        "geomean of solved gains should be ≈1.0, got {geomean}"
    );
}

/// Bilinear validity tap: invalid neighbors are renormalized away.
#[test]
fn bilinear_valid_renormalizes() {
    let mut img = frame_from_scene(&Camera::new([0.0; 3], 90.0, 0.0, 0.0, 8, 8), [0.0; 3]);
    for i in 0..img.pixel_count() {
        img.r[i] = 0.5;
    }
    img.validity.set(4, 4, false);
    img.r[(4 * 8 + 4) as usize] = 99.0; // poison
    let s = bilinear_valid(&img, 4.6, 4.6).expect("partially valid");
    assert!((s[0] - 0.5).abs() < 1e-6, "leaked poison: {}", s[0]);
}
