//! Integration tests for the ground-truth renderer (#1119):
//!
//! 1. Two overlapping rendered frames agree in their overlap when mapped
//!    through the ground-truth cameras — this is the property the M1/M2
//!    "warp RMSE" gates depend on.
//! 2. Determinism: same seed → byte-identical frames + JSON.
//! 3. The written `ground_truth.json` honors the documented schema.

use std::path::{Path, PathBuf};

use maple_pano::gt::GroundTruth;
use maple_pano::math::Vec3;
use maple_pano::prng::SplitMix64;
use maple_pano::render::{run, CameraSetOptions, Pattern, RenderJob, SourceKind};

/// Unique temp dir per test invocation (no tempfile dep in the workspace).
/// pid + per-process counter + tag make collisions impossible even with
/// parallel tests on a platform with coarse clock resolution.
fn temp_dir(tag: &str) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "maple-pano-test-{tag}-{}-{}-{:x}",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn job(seed: u64, cameras: u32, frame: (u32, u32), jitter_deg: f64) -> RenderJob {
    RenderJob {
        source: SourceKind::Synthetic {
            width: 256,
            height: 128,
        },
        set: CameraSetOptions {
            count: cameras,
            pattern: Pattern::Ring { full: false },
            fov_deg: 60.0,
            overlap: 0.5,
            pitch_deg: 0.0,
            jitter_deg,
            k1: -0.05,
            k2: 0.01,
            width: frame.0,
            height: frame.1,
        },
        supersample: 2,
        seed,
    }
}

/// Decode a rendered 16-bit RGB PNG back into u16 samples.
fn read_frame(path: &Path) -> (u32, u32, Vec<u16>) {
    let decoder = png::Decoder::new(std::fs::File::open(path).unwrap());
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0_u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!(info.bit_depth, png::BitDepth::Sixteen);
    assert_eq!(info.color_type, png::ColorType::Rgb);
    let data = buf[..info.buffer_size()]
        .chunks_exact(2)
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
        .collect();
    (info.width, info.height, data)
}

/// Bilinear sample of an interleaved u16 frame at continuous pixel
/// coordinates (texel centers at half-integers), normalized to [0, 1].
fn sample_frame(w: u32, h: u32, data: &[u16], px: f64, py: f64) -> [f64; 3] {
    let x = px - 0.5;
    let y = py - 0.5;
    let x0 = x.floor() as i64;
    let y0 = y.floor() as i64;
    let fx = x - x0 as f64;
    let fy = y - y0 as f64;
    let cl = |v: i64, hi: u32| v.clamp(0, hi as i64 - 1) as usize;
    let at = |ix: i64, iy: i64, c: usize| {
        data[(cl(iy, h) * w as usize + cl(ix, w)) * 3 + c] as f64 / 65535.0
    };
    let mut out = [0.0; 3];
    for (c, o) in out.iter_mut().enumerate() {
        let top = at(x0, y0, c) * (1.0 - fx) + at(x0 + 1, y0, c) * fx;
        let bot = at(x0, y0 + 1, c) * (1.0 - fx) + at(x0 + 1, y0 + 1, c) * fx;
        *o = top * (1.0 - fy) + bot * fy;
    }
    out
}

/// Render two overlapping cameras, then verify that world directions
/// visible in both frames sample to (nearly) the same linear values
/// through the ground-truth camera mappings. Tolerances absorb the two
/// frames' different pixel grids resampling the same scene (the synthetic
/// checker edges dominate the worst case).
#[test]
fn overlapping_frames_agree_through_ground_truth_cameras() {
    let dir = temp_dir("overlap");
    // 60° FOV, 50% overlap → 30° yaw step; jitter on so the test covers
    // the jittered-pose path end to end. Higher-res source for fidelity.
    let mut j = job(7, 2, (160, 120), 0.8);
    j.source = SourceKind::Synthetic {
        width: 1024,
        height: 512,
    };
    j.supersample = 3;
    let gt = run(&j, &dir, |_, _| {}).unwrap();

    let cam_a = gt.cameras[0].to_camera();
    let cam_b = gt.cameras[1].to_camera();
    let (wa, ha, frame_a) = read_frame(&dir.join(&gt.cameras[0].frame));
    let (wb, hb, frame_b) = read_frame(&dir.join(&gt.cameras[1].frame));

    // Probe directions: rays through camera A's pixel grid; keep the ones
    // that land inside camera B too (with margin for the bilinear support).
    let margin = 2.0;
    let mut rng = SplitMix64::new(99);
    let mut n = 0_u32;
    let mut sum_sq = 0.0_f64;
    let mut max_abs = 0.0_f64;
    for _ in 0..4000 {
        let px = rng.next_range(margin, wa as f64 - margin);
        let py = rng.next_range(margin, ha as f64 - margin);
        let d: Vec3 = cam_a.pixel_to_world_dir(px, py).unwrap();
        let Some((qx, qy)) = cam_b.world_dir_to_pixel(d) else {
            continue;
        };
        if !cam_b.pixel_in_bounds(qx, qy, margin) {
            continue;
        }
        let a = sample_frame(wa, ha, &frame_a, px, py);
        let b = sample_frame(wb, hb, &frame_b, qx, qy);
        for c in 0..3 {
            let diff: f64 = a[c] - b[c];
            sum_sq += diff * diff;
            max_abs = max_abs.max(diff.abs());
            n += 1;
        }
    }
    assert!(n >= 600, "too few overlap probes hit both frames: {n}");
    let rmse = (sum_sq / n as f64).sqrt();
    eprintln!("overlap-consistency: samples={n} rmse={rmse:.6} max_abs={max_abs:.6}");
    // Same scene, two pixel grids: RMSE stays well under 1% of full
    // scale; the max sits on checker/feature edges. Bounds are ~3× the
    // observed values (rmse 0.0027, max 0.0195 at seed 7) so a genuine
    // mapping bug (sign flip, off-by-one, wrong convention — all ≫ 0.1)
    // fails loudly while resampling noise never trips it.
    assert!(
        rmse < 0.008,
        "overlap RMSE too high: {rmse} over {n} samples"
    );
    assert!(max_abs < 0.06, "overlap max |Δ| too high: {max_abs}");

    std::fs::remove_dir_all(&dir).ok();
}

/// Same seed → byte-identical frames and JSON; different seed → different
/// pixels (the seed must actually steer the output).
#[test]
fn same_seed_renders_byte_identical_outputs() {
    let dir_a = temp_dir("det-a");
    let dir_b = temp_dir("det-b");
    let dir_c = temp_dir("det-c");
    let j = job(1234, 2, (48, 36), 0.7);
    run(&j, &dir_a, |_, _| {}).unwrap();
    run(&j, &dir_b, |_, _| {}).unwrap();
    let mut j_other = j.clone();
    j_other.seed = 4321;
    run(&j_other, &dir_c, |_, _| {}).unwrap();

    let files = ["frame_0000.png", "frame_0001.png", "ground_truth.json"];
    for f in files {
        let a = std::fs::read(dir_a.join(f)).unwrap();
        let b = std::fs::read(dir_b.join(f)).unwrap();
        assert_eq!(a, b, "{f} differs between identical-seed renders");
    }
    let a0 = std::fs::read(dir_a.join("frame_0000.png")).unwrap();
    let c0 = std::fs::read(dir_c.join("frame_0000.png")).unwrap();
    assert_ne!(a0, c0, "different seed must change rendered pixels");

    for d in [dir_a, dir_b, dir_c] {
        std::fs::remove_dir_all(&d).ok();
    }
}

/// The written ground_truth.json parses into the schema types, matches the
/// returned document, and carries the documented invariants.
#[test]
fn ground_truth_json_honors_schema() {
    let dir = temp_dir("schema");
    let j = job(5, 3, (32, 24), 0.0);
    let returned = run(&j, &dir, |_, _| {}).unwrap();

    let text = std::fs::read_to_string(dir.join("ground_truth.json")).unwrap();
    let parsed: GroundTruth = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed, returned);

    assert_eq!(parsed.version, 1);
    assert_eq!(parsed.source.projection, "equirectangular");
    assert_eq!(parsed.source.kind, "synthetic");
    assert_eq!(parsed.source.seed, Some(5));
    assert_eq!(parsed.source.lon_range_deg, [-180.0, 180.0]);
    assert_eq!(parsed.source.lat_range_deg, [-90.0, 90.0]);
    assert_eq!(parsed.render.supersample, 2);
    assert_eq!(parsed.cameras.len(), 3);
    for (i, cam) in parsed.cameras.iter().enumerate() {
        assert_eq!(cam.frame, format!("frame_{i:04}.png"));
        assert!(dir.join(&cam.frame).is_file(), "{} missing", cam.frame);
        assert_eq!((cam.width, cam.height), (32, 24));
        assert!(cam.focal_px > 0.0);
        // 60° FOV on a 32 px frame → f = 16/tan(30°) ≈ 27.7128.
        assert!((cam.focal_px - 27.712812).abs() < 1e-3);
    }
    // Raw JSON field spotcheck — the schema names are the contract.
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    let cam0 = &value["cameras"][0];
    assert!(cam0["axis_angle"].as_array().unwrap().len() == 3);
    for key in ["focal_px", "k1", "k2", "width", "height", "frame"] {
        assert!(!cam0[key].is_null(), "cameras[0].{key} missing");
    }
    for key in [
        "world_frame",
        "camera_frame",
        "rotation",
        "longitude",
        "latitude",
    ] {
        assert!(
            value["convention"][key].is_string(),
            "convention.{key} missing"
        );
    }

    std::fs::remove_dir_all(&dir).ok();
}
