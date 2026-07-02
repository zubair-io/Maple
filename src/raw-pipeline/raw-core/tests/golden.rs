//! Golden tests: render a fixture + XMP and compare against the reference
//! via `src/scripts/compare_images.py`. Gated by `--features golden` because
//! they shell out to Python.
//!
//! Run: `cargo test -p raw-core --features golden golden -- --nocapture --test-threads=1`

#![cfg(feature = "golden")]
#![allow(non_snake_case)]

use raw_core::{decode, pipeline, png, xmp};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Deserialize, Debug)]
struct DiffReport {
    mean_deltaE: f32,
    p95_deltaE: f32,
    max_deltaE: f32,
    bias_r: f32,
    bias_g: f32,
    bias_b: f32,
    n_pixels: u64,
}

struct Budget {
    mean: f32,
    p95: f32,
    max: f32,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("canonicalize")
}

fn budget_for(case_class: &str) -> Budget {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/budgets.toml");
    let s = std::fs::read_to_string(&path).expect("budgets.toml");
    let mut section = false;
    let mut found_section = false;
    // NaN sentinels: a class section that never sets a field, an unknown
    // class, or an unparseable value must FAIL the test, not default to an
    // infinite (always-passing) budget (#1082).
    let mut b = Budget {
        mean: f32::NAN,
        p95: f32::NAN,
        max: f32::NAN,
    };
    for line in s.lines() {
        let t = line.trim();
        if t.starts_with('#') || t.is_empty() {
            continue;
        }
        if t.starts_with('[') {
            section = t == format!("[{}]", case_class);
            found_section |= section;
            continue;
        }
        if !section {
            continue;
        }
        if let Some((k, v)) = t.split_once('=') {
            let k = k.trim();
            // Strip inline comments (e.g. "23.0  # RELAXED ...") before parsing.
            let v = v.trim().split('#').next().unwrap_or("").trim();
            let parsed = || -> f32 {
                v.parse().unwrap_or_else(|e| {
                    panic!(
                        "budgets.toml: unparseable {} = {:?} in [{}]: {}",
                        k, v, case_class, e
                    )
                })
            };
            match k {
                "mean_delta_e" => b.mean = parsed(),
                "p95_delta_e" => b.p95 = parsed(),
                "max_delta_e" => b.max = parsed(),
                _ => {}
            }
        }
    }
    assert!(
        found_section,
        "budgets.toml has no [{}] section — unknown case class",
        case_class
    );
    assert!(
        b.mean.is_finite() && b.p95.is_finite() && b.max.is_finite(),
        "budgets.toml [{}] is missing one of mean_delta_e / p95_delta_e / max_delta_e \
         (got mean={} p95={} max={})",
        case_class,
        b.mean,
        b.p95,
        b.max
    );
    b
}

fn run_case(stem: &str, case: &str, class: &str) {
    let root = repo_root();
    let raw_glob = root.join("test-fixtures/raws");
    let raw = ["DNG", "dng", "RAW", "CR2", "cr2"]
        .iter()
        .map(|ext| raw_glob.join(format!("{}.{}", stem, ext)))
        .find(|p| p.exists())
        .unwrap_or_else(|| panic!("no raw for {} found in {}", stem, raw_glob.display()));
    let xmp_path = root.join(format!(
        "test-fixtures/references/{}/xmp/{}.xmp",
        stem, case
    ));
    let ref_path = root.join(format!(
        "test-fixtures/references/{}/down/{}.png",
        stem, case
    ));
    // `--features golden` is an explicit opt-in, so a missing sidecar or
    // reference is broken provisioning — fail, don't silently skip (#1082).
    assert!(
        xmp_path.exists(),
        "{}/{}: xmp missing at {} (provision test-fixtures/references/, \
         or run without --features golden)",
        stem,
        case,
        xmp_path.display()
    );
    assert!(
        ref_path.exists(),
        "{}/{}: reference missing at {} (provision test-fixtures/references/, \
         or run without --features golden)",
        stem,
        case,
        ref_path.display()
    );

    let xml = std::fs::read_to_string(&xmp_path).unwrap();
    let model = xmp::parse(&xml).unwrap();
    let raw_bytes = std::fs::read(&raw).unwrap();
    let raw_ext = raw.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw_img = decode::decode_bytes(&raw_bytes, raw_ext).unwrap();
    let (w, h, bytes) = pipeline::render_from_raw(&raw_img, &model).unwrap();
    let out_dir = root.join("target/golden-out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let out_png = out_dir.join(format!("{}_{}.png", stem, case));
    let png_bytes = png::encode(w, h, &bytes).unwrap();
    std::fs::write(&out_png, &png_bytes).unwrap();

    // Resize our render to match the down/ reference (4000 px long-edge).
    // Easiest: have compare_images.py resize candidate to match reference.
    // For now, if dimensions differ, use Python+PIL to resample our output,
    // then compare. We do that inline to keep the harness self-contained.
    let resized = out_dir.join(format!("{}_{}_resized.png", stem, case));
    let resize_status = Command::new("python3")
        .arg("-c")
        .arg(
            "import sys; from PIL import Image; \
             cand = Image.open(sys.argv[-3]); \
             ref = Image.open(sys.argv[-2]); \
             cand.resize(ref.size, Image.LANCZOS).save(sys.argv[-1])",
        )
        .arg("--")
        .arg(&out_png)
        .arg(&ref_path)
        .arg(&resized)
        .status()
        .expect("python resize");
    assert!(resize_status.success(), "resize failed");

    let script = root.join("src/scripts/compare_images.py");
    let out = Command::new("python3")
        .arg("--")
        .arg(&script)
        .arg("--")
        .arg(&resized)
        .arg(&ref_path)
        .output()
        .expect("spawn compare_images.py");
    if !out.status.success() {
        panic!("compare failed: {}", String::from_utf8_lossy(&out.stderr));
    }
    let rep: DiffReport = serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "json parse: {} body: {}",
            e,
            String::from_utf8_lossy(&out.stdout)
        )
    });
    let b = budget_for(class);

    eprintln!("{}/{}: mean ΔE={:.2} p95={:.2} max={:.2} bias=({:+.3},{:+.3},{:+.3}) [budget mean={} p95={} max={}]",
        stem, case, rep.mean_deltaE, rep.p95_deltaE, rep.max_deltaE,
        rep.bias_r, rep.bias_g, rep.bias_b, b.mean, b.p95, b.max);

    assert!(
        rep.mean_deltaE <= b.mean,
        "{}/{}: mean ΔE {} > budget {}",
        stem,
        case,
        rep.mean_deltaE,
        b.mean
    );
    assert!(
        rep.p95_deltaE <= b.p95,
        "{}/{}: p95 ΔE {} > budget {}",
        stem,
        case,
        rep.p95_deltaE,
        b.p95
    );
    assert!(
        rep.max_deltaE <= b.max,
        "{}/{}: max ΔE {} > budget {}",
        stem,
        case,
        rep.max_deltaE,
        b.max
    );
}

#[test]
fn test_0002_baseline() {
    run_case("test_0002", "baseline", "baseline");
}
#[test]
fn test_0002_exposure_max() {
    run_case("test_0002", "exposure_max", "exposure");
}
#[test]
fn test_0002_exposure_min() {
    run_case("test_0002", "exposure_min", "exposure");
}
#[test]
fn test_0002_wb_daylight() {
    run_case("test_0002", "wb_daylight", "wb");
}
#[test]
fn test_0002_wb_tungsten() {
    run_case("test_0002", "wb_tungsten", "wb");
}
#[test]
fn test_0002_dehaze_max() {
    run_case("test_0002", "dehaze_max", "dehaze");
}

#[test]
fn test_0003_baseline() {
    run_case("test_0003", "baseline", "baseline");
}
#[test]
fn test_0000_baseline() {
    run_case("test_0000", "baseline", "baseline");
}
#[test]
fn test_0001_baseline() {
    run_case("test_0001", "baseline", "baseline");
}

#[test]
fn test_0002_contrast_max() {
    run_case("test_0002", "contrast_max", "contrast");
}
#[test]
fn test_0002_contrast_min() {
    run_case("test_0002", "contrast_min", "contrast");
}
#[test]
fn test_0002_highlights_max() {
    run_case("test_0002", "highlights_max", "highlights");
}
#[test]
fn test_0002_highlights_min() {
    run_case("test_0002", "highlights_min", "highlights");
}
#[test]
fn test_0002_shadows_max() {
    run_case("test_0002", "shadows_max", "shadows");
}
#[test]
fn test_0002_shadows_min() {
    run_case("test_0002", "shadows_min", "shadows");
}
#[test]
fn test_0002_whites_max() {
    run_case("test_0002", "whites_max", "whites");
}
#[test]
fn test_0002_whites_min() {
    run_case("test_0002", "whites_min", "whites");
}
#[test]
fn test_0002_blacks_max() {
    run_case("test_0002", "blacks_max", "blacks");
}
#[test]
fn test_0002_blacks_min() {
    run_case("test_0002", "blacks_min", "blacks");
}

#[test]
fn test_0002_vibrance_max() {
    run_case("test_0002", "vibrance_max", "vibrance");
}
#[test]
fn test_0002_vibrance_min() {
    run_case("test_0002", "vibrance_min", "vibrance");
}
#[test]
fn test_0002_saturation_max() {
    run_case("test_0002", "saturation_max", "saturation");
}
#[test]
fn test_0002_saturation_min() {
    run_case("test_0002", "saturation_min", "saturation");
}
#[test]
fn test_0002_clarity_max() {
    run_case("test_0002", "clarity_max", "clarity");
}
#[test]
fn test_0002_clarity_min() {
    run_case("test_0002", "clarity_min", "clarity");
}
#[test]
fn test_0002_texture_max() {
    run_case("test_0002", "texture_max", "texture");
}
#[test]
fn test_0002_texture_min() {
    run_case("test_0002", "texture_min", "texture");
}

#[test]
fn test_0002_sharpen_amount_max() {
    run_case("test_0002", "sharpen_amount_max", "sharpen");
}
#[test]
fn test_0002_sharpen_amount_min() {
    run_case("test_0002", "sharpen_amount_min", "sharpen");
}
#[test]
fn test_0002_sharpen_radius_max() {
    run_case("test_0002", "sharpen_radius_max", "sharpen");
}
#[test]
fn test_0002_sharpen_radius_min() {
    run_case("test_0002", "sharpen_radius_min", "sharpen");
}
#[test]
fn test_0002_sharpen_detail_max() {
    run_case("test_0002", "sharpen_detail_max", "sharpen");
}
#[test]
fn test_0002_sharpen_detail_min() {
    run_case("test_0002", "sharpen_detail_min", "sharpen");
}
#[test]
fn test_0002_sharpen_masking_max() {
    run_case("test_0002", "sharpen_masking_max", "sharpen");
}
#[test]
fn test_0002_nr_luminance_max() {
    run_case("test_0002", "nr_luminance_max", "nr");
}
#[test]
fn test_0002_nr_color_max() {
    run_case("test_0002", "nr_color_max", "nr");
}
#[test]
fn test_0002_nr_color_min() {
    run_case("test_0002", "nr_color_min", "nr");
}
