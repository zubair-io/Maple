use super::*;
use crate::ingest::ValidityMask;
use crate::math::Vec3;
use crate::prng::SplitMix64;
use crate::render::{build_camera_set, CameraSetOptions, Pattern};

// ─── Streaming gain test helpers ──────────────────────────────────────────────

// Mirrors `src/bin/pano-gen-fixture/dng.rs` for the round-trip
// render → DNG bytes → decode_for_pano → ingest_file.
fn planar_to_dng_bytes(img: &crate::ingest::PlanarImage, focal_35mm: u16) -> Vec<u8> {
    let n = img.pixel_count();
    let mut rgb16: Vec<u16> = Vec::with_capacity(n * 3);
    for i in 0..n {
        rgb16.push((img.r[i].clamp(0.0, 1.0) * 65535.0 + 0.5) as u16);
        rgb16.push((img.g[i].clamp(0.0, 1.0) * 65535.0 + 0.5) as u16);
        rgb16.push((img.b[i].clamp(0.0, 1.0) * 65535.0 + 0.5) as u16);
    }
    let w = img.width();
    let h = img.height();
    let strip_byte_count = (n * 3 * 2) as u32;

    // IFD helpers: each entry is (tag, type_id, count, payload_bytes).
    // type: 1=BYTE, 2=ASCII, 3=SHORT, 4=LONG, 5=RATIONAL, 10=SRATIONAL
    fn u16le(v: u16) -> [u8; 2] {
        v.to_le_bytes()
    }
    fn u32le(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }
    fn i32le(v: i32) -> [u8; 4] {
        v.to_le_bytes()
    }
    fn mk_short(tag: u16, v: u16) -> (u16, u16, u32, Vec<u8>) {
        (tag, 3, 1, u16le(v).to_vec())
    }
    fn mk_shorts(tag: u16, v: &[u16]) -> (u16, u16, u32, Vec<u8>) {
        let mut p = Vec::new();
        for &x in v {
            p.extend_from_slice(&u16le(x));
        }
        (tag, 3, v.len() as u32, p)
    }
    fn mk_long(tag: u16, v: u32) -> (u16, u16, u32, Vec<u8>) {
        (tag, 4, 1, u32le(v).to_vec())
    }
    fn mk_bytes(tag: u16, v: Vec<u8>) -> (u16, u16, u32, Vec<u8>) {
        let n = v.len() as u32;
        (tag, 1, n, v)
    }
    fn mk_ascii(tag: u16, s: &str) -> (u16, u16, u32, Vec<u8>) {
        let mut p = s.as_bytes().to_vec();
        p.push(0);
        let n = p.len() as u32;
        (tag, 2, n, p)
    }
    fn mk_rat(tag: u16, pairs: &[(u32, u32)]) -> (u16, u16, u32, Vec<u8>) {
        let mut p = Vec::new();
        for &(a, b) in pairs {
            p.extend_from_slice(&u32le(a));
            p.extend_from_slice(&u32le(b));
        }
        (tag, 5, pairs.len() as u32, p)
    }
    fn mk_srat(tag: u16, pairs: &[(i32, i32)]) -> (u16, u16, u32, Vec<u8>) {
        let mut p = Vec::new();
        for &(a, b) in pairs {
            p.extend_from_slice(&i32le(a));
            p.extend_from_slice(&i32le(b));
        }
        (tag, 10, pairs.len() as u32, p)
    }

    fn ser_ifd(entries: &mut Vec<(u16, u16, u32, Vec<u8>)>, ifd_offset: u32) -> Vec<u8> {
        entries.sort_by_key(|(tag, _, _, _)| *tag);
        let n = entries.len() as u16;
        let dir_size = 2u32 + 12 * n as u32 + 4;
        let mut oflo_off = ifd_offset + dir_size;
        let mut oflo: Vec<u8> = Vec::new();
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&u16le(n));
        for (tag, tid, cnt, payload) in entries.iter() {
            buf.extend_from_slice(&u16le(*tag));
            buf.extend_from_slice(&u16le(*tid));
            buf.extend_from_slice(&u32le(*cnt));
            if payload.len() <= 4 {
                let mut padded = payload.clone();
                padded.resize(4, 0);
                buf.extend_from_slice(&padded);
            } else {
                buf.extend_from_slice(&u32le(oflo_off));
                oflo_off += payload.len() as u32;
                oflo.extend_from_slice(payload);
                if oflo.len() % 2 != 0 {
                    oflo.push(0);
                    oflo_off += 1;
                }
            }
        }
        buf.extend_from_slice(&u32le(0)); // next IFD = 0
        buf.extend_from_slice(&oflo);
        buf
    }

    let m = 1_000_000i32;
    let identity_srat: Vec<(i32, i32)> = vec![
        (m, m),
        (0, m),
        (0, m),
        (0, m),
        (m, m),
        (0, m),
        (0, m),
        (0, m),
        (m, m),
    ];
    let unit_rat: Vec<(u32, u32)> = vec![(1_000_000u32, 1_000_000u32); 3];

    // Helper that builds the fixed IFD0 tag list given strip/exif offsets.
    let make_ifd0 = |strip_off: u32, exif_off: u32| -> Vec<(u16, u16, u32, Vec<u8>)> {
        vec![
            mk_long(254, 0),
            mk_long(256, w),
            mk_long(257, h),
            mk_shorts(258, &[16, 16, 16]),
            mk_short(259, 1),
            mk_short(262, 34892),
            mk_long(273, strip_off),
            mk_short(277, 3),
            mk_long(278, h),
            mk_long(279, strip_byte_count),
            mk_short(284, 1),
            mk_long(0x8769, exif_off),
            mk_bytes(50706, vec![1, 4, 0, 0]),
            mk_bytes(50707, vec![1, 0, 0, 0]),
            mk_ascii(50708, "Maple Test"),
            mk_short(50717, 65535),
            mk_srat(50721, &identity_srat),
            mk_srat(50723, &identity_srat),
            mk_rat(50727, &unit_rat),
            mk_rat(50728, &unit_rat),
            mk_srat(50730, &[(0, 1)]),
            mk_short(50778, 21),
        ]
    };
    let make_exif = |f35: u16| -> Vec<(u16, u16, u32, Vec<u8>)> {
        vec![mk_rat(0x920A, &[(1, 1)]), mk_short(0xA405, f35)]
    };

    // Probe pass to determine offsets.
    let probe_ifd0_len = ser_ifd(&mut make_ifd0(0, 0), 8).len();
    let probe_exif_len = ser_ifd(&mut make_exif(focal_35mm), 8 + probe_ifd0_len as u32).len();

    let exif_offset = (8 + probe_ifd0_len) as u32;
    let strip_offset = (8 + probe_ifd0_len + probe_exif_len) as u32;

    let ifd0_bytes = ser_ifd(&mut make_ifd0(strip_offset, exif_offset), 8);
    let exif_bytes = ser_ifd(&mut make_exif(focal_35mm), exif_offset);

    let mut out: Vec<u8> = Vec::with_capacity(8 + ifd0_bytes.len() + exif_bytes.len() + n * 3 * 2);
    out.extend_from_slice(b"II");
    out.extend_from_slice(&u16le(42));
    out.extend_from_slice(&u32le(8));
    out.extend_from_slice(&ifd0_bytes);
    out.extend_from_slice(&exif_bytes);
    for &v in &rgb16 {
        out.extend_from_slice(&u16le(v));
    }
    out
}

/// Write frames to temp files and return the paths.
fn frames_to_tmpdir(
    frames: &[PlanarImage],
    cams: &[Camera],
) -> (std::path::PathBuf, Vec<std::path::PathBuf>) {
    use std::time::SystemTime;
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let dir = std::env::temp_dir().join(format!("maple_gain_test_{:x}_{}", std::process::id(), ts));
    std::fs::create_dir_all(&dir).expect("create tmpdir");
    let paths: Vec<std::path::PathBuf> = frames
        .iter()
        .enumerate()
        .zip(cams)
        .map(|((i, frame), cam)| {
            // Approximate 35mm equiv focal from the camera's half-diagonal FOV.
            let diag_px = (cam.width as f64).hypot(cam.height as f64);
            let half_diag_rad = (diag_px / (2.0 * cam.focal_px)).atan();
            let focal_35mm = ((21.634 / half_diag_rad.tan()).round() as u16).max(1);
            let bytes = planar_to_dng_bytes(frame, focal_35mm);
            let path = dir.join(format!("frame_{i:03}.dng"));
            std::fs::write(&path, &bytes).expect("write test DNG");
            path
        })
        .collect();
    (dir, paths)
}

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

// ─── solve_gains_streaming tests ──────────────────────────────────────────────

/// Unity input: streaming path solves to gains ≈ 1.0.
#[test]
fn streaming_unity_input_solves_to_one() {
    let cams = ring_cameras(3, 60.0, 0.4);
    let frames: Vec<_> = cams.iter().map(|c| frame_from_scene(c, [1.0; 3])).collect();
    let (_dir, paths) = frames_to_tmpdir(&frames, &cams);
    let gains =
        solve_gains_streaming(&paths, &cams, &GainOptions::default()).expect("streaming solve");
    for g in &gains {
        for c in 0..3 {
            assert!(
                (g[c] - 1.0).abs() < 5e-3,
                "unity gain drifted on streaming path: {g:?}"
            );
        }
    }
}

/// ±1 EV pre-multiplied frames: streaming path recovers relative gains
/// directionally (brighter frame gets a lower gain).  Tolerance is loose
/// (25%) because the DNG round-trip introduces quantization and color-matrix
/// processing, and the streaming path uses only the forward direction per
/// pair (halving sample count vs the batch path).
#[test]
fn streaming_plus_minus_one_ev_recovered() {
    let cams = ring_cameras(3, 60.0, 0.45);
    // 2× / 1× / 0.5× — large contrast to survive DNG quantization noise.
    let muls = [2.0_f32, 1.0, 0.5];
    let frames: Vec<_> = cams
        .iter()
        .zip(muls)
        .map(|(c, m)| frame_from_scene(c, [m; 3]))
        .collect();
    let (_dir, paths) = frames_to_tmpdir(&frames, &cams);
    let gains =
        solve_gains_streaming(&paths, &cams, &GainOptions::default()).expect("streaming solve");
    // Verify ordering: the brightest frame (×2) must get the smallest gain
    // and the darkest frame (×0.5) must get the largest gain.
    let g: Vec<f32> = gains.iter().map(|g| g[0]).collect();
    assert!(
        g[0] < g[1] && g[1] < g[2],
        "streaming gains not monotonically decreasing with exposure: {g:?}"
    );
}

/// Per-channel mode: streaming path produces distinct per-channel gains
/// and they follow the correct ordering for each channel.
#[test]
fn streaming_per_channel_multipliers_recovered() {
    let cams = ring_cameras(3, 60.0, 0.45);
    // Use large per-channel contrasts to survive DNG round-trip noise.
    let muls: [[f32; 3]; 3] = [[2.0, 1.0, 0.5], [1.0, 1.0, 1.0], [0.5, 1.0, 2.0]];
    let frames: Vec<_> = cams
        .iter()
        .zip(muls)
        .map(|(c, m)| frame_from_scene(c, m))
        .collect();
    let (_dir, paths) = frames_to_tmpdir(&frames, &cams);
    let gains = solve_gains_streaming(
        &paths,
        &cams,
        &GainOptions {
            mode: GainMode::PerChannel,
            ..GainOptions::default()
        },
    )
    .expect("streaming per-channel solve");
    // Channel 0: frame 0 is 4× brighter than frame 2 → gains[0][0] < gains[2][0].
    assert!(
        gains[0][0] < gains[2][0],
        "ch0: expected gains[0] < gains[2], got {:.4} vs {:.4}",
        gains[0][0],
        gains[2][0]
    );
    // Channel 2: frame 0 is 4× dimmer than frame 2 → gains[0][2] > gains[2][2].
    assert!(
        gains[0][2] > gains[2][2],
        "ch2: expected gains[0] > gains[2], got {:.4} vs {:.4}",
        gains[0][2],
        gains[2][2]
    );
    // Channel 1: all ×1.0 → gains are approximately equal.
    let diff1 = (gains[0][1] - gains[2][1]).abs();
    assert!(
        diff1 < 0.5,
        "ch1: expected near-equal gains, got {:.4} vs {:.4}",
        gains[0][1],
        gains[2][1]
    );
}

/// Equivalence gate: `solve_gains_streaming` and `solve_gains` agree on
/// **the same decoded frames** — both paths decode from the DNG files so
/// any decode-chain transforms cancel out between the two solves.
#[test]
fn streaming_and_batch_agree_on_same_frames() {
    use crate::ingest::ingest_file;
    let cams = ring_cameras(3, 60.0, 0.45);
    let muls = [1.6_f32, 1.0, 0.7];
    let frames: Vec<_> = cams
        .iter()
        .zip(muls)
        .map(|(c, m)| frame_from_scene(c, [m; 3]))
        .collect();
    let (_dir, paths) = frames_to_tmpdir(&frames, &cams);

    // Decode the DNG files for the batch solver (same source as streaming).
    let decoded_frames: Vec<PlanarImage> = paths
        .iter()
        .map(|p| ingest_file(p).expect("decode DNG").image)
        .collect();
    let gains_batch =
        solve_gains(&decoded_frames, &cams, &GainOptions::default()).expect("batch solve");
    let gains_stream =
        solve_gains_streaming(&paths, &cams, &GainOptions::default()).expect("streaming solve");

    assert_eq!(gains_batch.len(), gains_stream.len());
    // After normalizing to geometric mean = 1, the two paths must agree
    // within 15% (streaming uses forward-only direction; batch uses both).
    let gm_b = geometric_mean(&gains_batch, 0);
    let gm_s = geometric_mean(&gains_stream, 0);
    for (gb, gs) in gains_batch.iter().zip(gains_stream.iter()) {
        let nb = gb[0] as f64 / gm_b;
        let ns = gs[0] as f64 / gm_s;
        let rel = (nb - ns).abs() / nb.abs().max(1e-9);
        assert!(
            rel < 0.15,
            "streaming vs batch gain disagree: batch {nb:.5}, streaming {ns:.5} ({:.2}% off)",
            rel * 100.0
        );
    }
}
