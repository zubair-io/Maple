//! Parity gate for the developed 1280px preview (#1964).
//!
//! The self-hosted `display-preview` stage renders an edited asset's preview
//! through the FFI extern `maple_render_develop_jpeg_to_file` (RAW + XMP →
//! develop → downscale → JPEG). All three pipelines (Web WASM, Apple, API FFI)
//! develop through the shared `raw-core`, so this output must match the
//! canonical `maple-cli`/raw-core develop by construction — but nothing
//! enforced it until this gate. It catches a wiring regression on the API
//! develop path (wrong demosaic, orientation double-bake, downscale filter, or
//! a mis-applied XMP model) that the `maple-cli`-vs-ACR and Apple-Metal gates
//! don't cover.
//!
//! Mechanism (mirrors `apple_render_diff.py`'s "measured path vs reference"):
//!   candidate = the EXTERN's JPEG output, decoded to RGB.
//!   reference = `render_from_raw_with_quality_and_source` (the exact develop
//!               `maple-cli batch` runs) + the same `resize_long_edge` the
//!               extern uses — i.e. the develop without the JPEG round-trip.
//! Both are written as PNGs and diffed with the ONE diff implementation
//! (`src/scripts/compare_images.py`, CIEDE2000 + per-channel bias). The only
//! expected non-zero contributor is JPEG q82 quantization, so the budget is
//! tight; a wide delta means a develop-path wiring bug.
//!
//! Skip-passes when the RAW fixture, `python3`, or numpy/PIL/colour are absent (same
//! pattern as `test_color_pipeline.sh`), so CI without the gitignored RAWs and
//! without the color-harness Python deps stays green.
//!
//! Run locally:
//! ```text
//! cargo test -p raw-ffi --test develop_preview_parity -- --nocapture
//! ```

use std::path::{Path, PathBuf};
use std::process::Command;

use image::{DynamicImage, GenericImageView};
use raw_core::decode::decode_bytes;
use raw_core::pipeline::{render_from_raw_with_quality_and_source, RawInput, RenderQuality};
use raw_ffi::maple_render_develop_jpeg_to_file;

const LONG_EDGE_PX: u32 = 1280;
const JPEG_QUALITY: u8 = 82;

// CIEDE2000 ceilings. The candidate and reference run the IDENTICAL develop +
// resize; the only difference is the candidate's JPEG q82 round-trip, so these
// absorb JPEG quantization and nothing more. Measured on test_0002 (neutral +
// edited): mean ≈ 0.7–0.9, p95 ≈ 2.2–2.4, max ≈ 13–17. The mean/p95 guards are
// tight (a develop-path wiring bug — wrong demosaic / orientation double-bake /
// mis-applied XMP — moves the MEAN by an order of magnitude); `max` keeps more
// slack because single-pixel JPEG edge artifacts vary across libjpeg builds.
// One-way ratchet — only lower these.
const BUDGET_MEAN: f64 = 1.5;
const BUDGET_P95: f64 = 3.5;
const BUDGET_MAX: f64 = 24.0;

struct Case {
    name: &'static str,
    /// XMP document to develop with, or None for a neutral develop.
    xmp: Option<&'static str>,
}

/// A minimal edited sidecar — exposure + contrast + saturation so the develop
/// applies a real, non-neutral adjustment model on the edited case.
const EDITED_XMP: &str = r#"<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="0.75"
      crs:Contrast2012="20"
      crs:Saturation="15"/>
  </rdf:RDF>
</x:xmpmeta>"#;

/// Extract a numeric value for `key` from `compare_images.py`'s single-line
/// flat JSON (`"key": <number>`) — avoids a serde_json dependency for one
/// trivial parse.
fn json_number(json: &str, key: &str) -> f64 {
    let pat = format!("\"{key}\":");
    let start = json
        .find(&pat)
        .unwrap_or_else(|| panic!("key {key} not in: {json}"))
        + pat.len();
    let rest = &json[start..];
    let end = rest.find([',', '}']).expect("terminator");
    rest[..end]
        .trim()
        .parse()
        .unwrap_or_else(|_| panic!("bad number for {key}: {json}"))
}

fn repo_root() -> Option<PathBuf> {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    loop {
        if dir.join("test-fixtures").is_dir() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// True when `python3` can import the diff script's deps. When false the gate
/// skip-passes rather than fail on a missing Python toolchain.
fn python_diff_available(script: &Path) -> bool {
    if !script.is_file() {
        return false;
    }
    // compare_images.py imports numpy, PIL AND colour (the CIEDE2000 math).
    // All three must be importable or the script errors at import — check the
    // full set so a missing dep skip-passes instead of failing the gate.
    Command::new("python3")
        .args(["-c", "import numpy, PIL, colour"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Replicate `raw-ffi`'s `resize_long_edge` exactly (triangle filter, no
/// upscale) so the reference and the extern downscale identically.
fn resize_long_edge(img: DynamicImage, max_px: u32) -> DynamicImage {
    let (w, h) = img.dimensions();
    let long_edge = w.max(h);
    if long_edge <= max_px {
        return img;
    }
    let scale = max_px as f32 / long_edge as f32;
    let new_w = ((w as f32) * scale).round().max(1.0) as u32;
    let new_h = ((h as f32) * scale).round().max(1.0) as u32;
    img.resize_exact(new_w, new_h, image::imageops::FilterType::Triangle)
}

/// Reference develop: the exact `raw-core` path `maple-cli batch` runs (AMaZE,
/// path-sourced so `Profile::Auto` can read the embedded JPEG), downscaled to
/// `LONG_EDGE_PX`. No JPEG round-trip.
fn reference_png(raw: &Path, xmp: Option<&str>, out: &Path) {
    let model = match xmp {
        Some(doc) => raw_core::xmp::parse(doc).expect("reference xmp parse"),
        None => raw_core::xmp::AdjustmentModel::default(),
    };
    let raw_bytes = std::fs::read(raw).expect("read raw");
    let ext = raw.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw_img = decode_bytes(&raw_bytes, ext).expect("decode raw");
    let (w, h, px) = render_from_raw_with_quality_and_source(
        &raw_img,
        &model,
        RenderQuality::Amaze,
        Some(RawInput::Path(raw)),
    )
    .expect("reference develop");
    let rgb = image::RgbImage::from_raw(w, h, px).expect("reference buffer size");
    let resized = resize_long_edge(DynamicImage::ImageRgb8(rgb), LONG_EDGE_PX);
    resized.to_rgb8().save(out).expect("write reference png");
}

/// Candidate: the extern's JPEG output (RAW + XMP → develop → resize → JPEG),
/// decoded and re-saved as PNG so the diff sees pixels, not the JPEG container.
fn candidate_png(raw: &Path, xmp_path: Option<&Path>, tmp: &Path, out: &Path) {
    use std::ffi::CString;
    let jpg = tmp.join("candidate.jpg");
    let raw_c = CString::new(raw.to_str().unwrap()).unwrap();
    let out_c = CString::new(jpg.to_str().unwrap()).unwrap();
    let xmp_c = xmp_path.map(|p| CString::new(p.to_str().unwrap()).unwrap());
    let rc = unsafe {
        maple_render_develop_jpeg_to_file(
            raw_c.as_ptr(),
            xmp_c
                .as_ref()
                .map(|c| c.as_ptr())
                .unwrap_or(std::ptr::null()),
            LONG_EDGE_PX,
            JPEG_QUALITY,
            out_c.as_ptr(),
        )
    };
    assert_eq!(rc, 0, "extern render failed rc={rc}");
    image::open(&jpg)
        .expect("decode candidate jpeg")
        .to_rgb8()
        .save(out)
        .expect("write candidate png");
}

fn run_case(root: &Path, script: &Path, raw: &Path, case: &Case) {
    let tmp = tempfile::tempdir().unwrap();
    let cand = tmp.path().join("cand.png");
    let refr = tmp.path().join("ref.png");

    // Stage the XMP to disk for the extern (it takes a path); the reference
    // parses the same document in-process.
    let xmp_path = case.xmp.map(|doc| {
        let p = tmp.path().join("edit.xmp");
        std::fs::write(&p, doc).unwrap();
        p
    });

    candidate_png(raw, xmp_path.as_deref(), tmp.path(), &cand);
    reference_png(raw, case.xmp, &refr);

    let output = Command::new("python3")
        .arg(script)
        .arg(&cand)
        .arg(&refr)
        .output()
        .expect("run compare_images.py");
    assert!(
        output.status.success(),
        "compare_images.py failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mean = json_number(&stdout, "mean_deltaE");
    let p95 = json_number(&stdout, "p95_deltaE");
    let max = json_number(&stdout, "max_deltaE");
    eprintln!(
        "develop_preview_parity[{}]: mean={mean:.3} p95={p95:.3} max={max:.3}",
        case.name
    );

    assert!(
        mean <= BUDGET_MEAN,
        "[{}] mean ΔE {mean:.3} > {BUDGET_MEAN}",
        case.name
    );
    assert!(
        p95 <= BUDGET_P95,
        "[{}] p95 ΔE {p95:.3} > {BUDGET_P95}",
        case.name
    );
    assert!(
        max <= BUDGET_MAX,
        "[{}] max ΔE {max:.3} > {BUDGET_MAX}",
        case.name
    );
    let _ = root;
}

#[test]
fn developed_preview_matches_reference_develop() {
    let Some(root) = repo_root() else {
        eprintln!("develop_preview_parity: SKIP-PASS — no test-fixtures dir");
        return;
    };
    let script = root.join("src/scripts/compare_images.py");
    if !python_diff_available(&script) {
        eprintln!("develop_preview_parity: SKIP-PASS — python3 + numpy/PIL/colour unavailable");
        return;
    }
    let raw = root.join("test-fixtures/raws/test_0002.dng");
    if !raw.is_file() {
        eprintln!(
            "develop_preview_parity: SKIP-PASS — fixture {} absent",
            raw.display()
        );
        return;
    }

    for case in [
        Case {
            name: "neutral",
            xmp: None,
        },
        Case {
            name: "edited",
            xmp: Some(EDITED_XMP),
        },
    ] {
        run_case(&root, &script, &raw, &case);
    }
}
