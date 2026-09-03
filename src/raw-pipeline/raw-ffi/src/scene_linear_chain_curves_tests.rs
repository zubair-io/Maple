//! Parity gate for the curves-aware fused entry (#3234).
//!
//! Windows' per-tick path (`RenderEngine.Decode` + `RenderEngine.RenderTick`)
//! is: `maple_render_file_scene_linear_sized_f32` on the chain-stripped
//! sidecar, then `maple_apply_chain_and_encode_display_curves_f32` with the
//! point curves handed over as flat `[0, 1]` knots. That sequence must land
//! on the develop reference (`render_from_raw_with_quality_and_source` with
//! the FULL sidecar — what `maple-cli render` produces) within the same
//! ΔE2000 budgets `tests/develop_preview_parity.rs` holds the JPEG preview
//! to. The control run feeds the same knots in the `[0, 255]` wire domain —
//! the pre-#3234 Windows behaviour — and must be measurably worse, which is
//! what makes the gate sensitive to the scale at all.
//!
//! Fixture-gated: skip-passes without `test-fixtures/raws/test_0002.dng` or
//! the python diff dependencies (`numpy`, `PIL`, `colour`). Ignored by
//! default — three native-resolution Amaze develops of the 50 MB fixture
//! take ~15 minutes on an M-series laptop — run it explicitly:
//!
//! ```text
//! cargo test -p raw-ffi --lib curves_entry -- --ignored --nocapture
//! ```
//!
//! Set `MAPLE_CURVES_PARITY_OUT=<dir>` to keep the three PNGs for triage.

use crate::buffers::{maple_free_scene_linear_buffer_f32, MapleSceneLinearBufferF32};
use crate::scene_linear_chain::MapleAdjustmentParams;
use crate::scene_linear_chain_curves::{
    maple_apply_chain_and_encode_display_curves_f32, MapleToneCurves,
};
use crate::scene_linear_f32::maple_render_file_scene_linear_sized_f32;
use raw_core::decode::decode_bytes;
use raw_core::pipeline::{render_from_raw_with_quality_and_source, RawInput, RenderQuality};
use raw_core::types::ToneCurve;
use raw_core::xmp::AdjustmentModel;
use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Both sides develop at native resolution and are resized with the SAME
/// filter before the diff, so the only thing left to differ is where the
/// point curve enters the chain (FFI knots vs. sidecar) — a sized FFI decode
/// would fold the core's own downsampler into the max ΔE instead.
const LONG_EDGE_PX: u32 = 1280;
/// "No downscale" for the FFI decode (`max_long_edge` must be > 0).
const NATIVE_RES: u32 = u32::MAX;
/// `quality_preview` value selecting `RenderQuality::Amaze` on the FFI decode
/// — the same demosaic the develop reference runs.
const QUALITY_AMAZE: i32 = 2;

const BUDGET_MEAN: f64 = 1.5;
const BUDGET_P95: f64 = 3.5;
const BUDGET_MAX: f64 = 24.0;

/// Both curve families, both non-identity, in the `[0, 255]` wire form a
/// Lightroom-authored (or other-Maple-platform-authored) sidecar carries.
const CURVE_CHILDREN: &str = r#"
      <papp:SceneLinearToneCurve>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>127.5, 140.25</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurve>
      <crs:ToneCurvePV2012Red>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>64, 48</rdf:li>
          <rdf:li>192, 205</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012Red>"#;

/// AE off + Neutral profile keep the decode deterministic and free of the
/// Auto Profile tail (which the Windows CPU path applies separately, via a
/// display LUT, and which is not what this gate measures).
fn sidecar(children: &str) -> String {
    format!(
        r#"<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      papp:AutoExposure="Off"
      papp:Profile="Neutral">{children}
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>"#
    )
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

fn python_diff_available(script: &Path) -> bool {
    script.is_file()
        && Command::new("python3")
            .args(["-c", "import numpy, PIL, colour"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
}

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

fn delta_e(script: &Path, candidate: &Path, reference: &Path) -> (f64, f64, f64) {
    let output = Command::new("python3")
        .arg(script)
        .arg(candidate)
        .arg(reference)
        .output()
        .expect("run compare_images.py");
    assert!(
        output.status.success(),
        "compare_images.py failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    (
        json_number(&stdout, "mean_deltaE"),
        json_number(&stdout, "p95_deltaE"),
        json_number(&stdout, "max_deltaE"),
    )
}

fn resize_long_edge(img: image::DynamicImage, max_px: u32) -> image::DynamicImage {
    use image::GenericImageView;
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

/// The Rust reference: the full sidecar through the develop path.
fn reference_png(raw: &Path, model: &AdjustmentModel, out: &Path) {
    let raw_bytes = std::fs::read(raw).expect("read raw");
    let ext = raw.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw_img = decode_bytes(&raw_bytes, ext).expect("decode raw");
    let (w, h, px) = render_from_raw_with_quality_and_source(
        &raw_img,
        model,
        RenderQuality::Amaze,
        Some(RawInput::Path(raw)),
    )
    .expect("reference develop");
    let rgb = image::RgbImage::from_raw(w, h, px).expect("reference buffer size");
    resize_long_edge(image::DynamicImage::ImageRgb8(rgb), LONG_EDGE_PX)
        .to_rgb8()
        .save(out)
        .expect("write reference png");
}

/// `RenderEngine.FlattenCurve`: `[x0, y0, x1, y1, …]`, scaled by
/// `knot_scale` (1.0 = the fixed `[0, 1]` model; 255.0 = the pre-#3234 wire
/// values the old Windows parser stored).
fn flatten(curve: &ToneCurve, knot_scale: f32) -> Vec<f32> {
    curve
        .points
        .iter()
        .flat_map(|(x, y)| [x * knot_scale, y * knot_scale])
        .collect()
}

fn to_byte(v: f32) -> u8 {
    ((v * 255.0 + 0.5) as i32).clamp(0, 255) as u8
}

/// The Windows per-tick path, call for call: decode the chain-stripped
/// sidecar through the FFI, then the fused curves entry with the sidecar's
/// point curves as flat knots.
unsafe fn windows_path_png(
    raw: &Path,
    stripped_xmp: &Path,
    model: &AdjustmentModel,
    knot_scale: f32,
    out: &Path,
) {
    let raw_c = CString::new(raw.to_str().unwrap()).unwrap();
    let xmp_c = CString::new(stripped_xmp.to_str().unwrap()).unwrap();
    let mut buf = MapleSceneLinearBufferF32::empty();
    let rc = maple_render_file_scene_linear_sized_f32(
        raw_c.as_ptr(),
        xmp_c.as_ptr(),
        NATIVE_RES,
        QUALITY_AMAZE,
        std::ptr::null(),
        &mut buf,
    );
    assert_eq!(rc, 0, "scene-linear decode rc={rc}");
    let (w, h) = (buf.width, buf.height);
    let lanes = (w * h * 4) as usize;
    let input = std::slice::from_raw_parts(buf.f32_rgba, lanes).to_vec();
    let noise = if buf.noise_profile_data.is_null() || buf.noise_profile_len == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(buf.noise_profile_data, buf.noise_profile_len as usize).to_vec()
    };

    // `MapleAdjustmentParams.From(defaultModel, decoded)` + `ApplyWbFrame`:
    // every scalar at the canonical default, WB at the decoded as-shot
    // identity, the decode-exported wb_frame block passed back verbatim.
    let mut p: MapleAdjustmentParams = std::mem::zeroed();
    let frame_present = buf.wb_frame_scene_cct > 0.0;
    p.temperature = if frame_present {
        buf.wb_frame_scene_cct
    } else {
        6500.0
    };
    p.tint = if frame_present {
        buf.wb_frame_as_shot_tint
    } else {
        0.0
    };
    p.decoded_temperature = p.temperature;
    p.decoded_tint = p.tint;
    p.look_mode = 1;
    p.vignette_feather = 50.0;
    p.grain_size = 25.0;
    p.grain_roughness = 50.0;
    p.sharpen_amount = 40.0;
    p.sharpen_radius = 1.0;
    p.sharpen_detail = 25.0;
    p.nr_color = 25.0;
    p.iso = buf.iso;
    if !noise.is_empty() {
        p.noise_profile_ptr = noise.as_ptr();
        p.noise_profile_len = noise.len() as u32;
    }
    p.wb_frame_m_cold = buf.wb_frame_m_cold;
    p.wb_frame_cct_cold = buf.wb_frame_cct_cold;
    p.wb_frame_m_warm = buf.wb_frame_m_warm;
    p.wb_frame_cct_warm = buf.wb_frame_cct_warm;
    p.wb_frame_scene_cct = buf.wb_frame_scene_cct;
    p.wb_frame_as_shot_tint = buf.wb_frame_as_shot_tint;
    p.wb_frame_render_cm = buf.wb_frame_render_cm;
    p.wb_frame_render_forward_matrix = buf.wb_frame_render_forward_matrix;
    p.wb_frame_render_scene_white_xyz = buf.wb_frame_render_scene_white_xyz;
    p.wb_frame_render_wb_already_baked = buf.wb_frame_render_wb_already_baked;
    p.wb_frame_render_cm_cold = buf.wb_frame_render_cm_cold;
    p.wb_frame_render_cct_cold = buf.wb_frame_render_cct_cold;
    p.wb_frame_render_cm_warm = buf.wb_frame_render_cm_warm;
    p.wb_frame_render_cct_warm = buf.wb_frame_render_cct_warm;
    p.wb_frame_render_fm_cold = buf.wb_frame_render_fm_cold;
    p.wb_frame_render_fm_warm = buf.wb_frame_render_fm_warm;
    maple_free_scene_linear_buffer_f32(&mut buf);

    let luma = flatten(&model.tone_curve_luma, knot_scale);
    let red = flatten(&model.tone_curve_red, knot_scale);
    let green = flatten(&model.tone_curve_green, knot_scale);
    let blue = flatten(&model.tone_curve_blue, knot_scale);
    let d_luma = flatten(&model.display_tone_curve_luma, knot_scale);
    let d_red = flatten(&model.display_tone_curve_red, knot_scale);
    let d_green = flatten(&model.display_tone_curve_green, knot_scale);
    let d_blue = flatten(&model.display_tone_curve_blue, knot_scale);
    let curves = MapleToneCurves {
        luma_ptr: luma.as_ptr(),
        luma_len: luma.len(),
        red_ptr: red.as_ptr(),
        red_len: red.len(),
        green_ptr: green.as_ptr(),
        green_len: green.len(),
        blue_ptr: blue.as_ptr(),
        blue_len: blue.len(),
        mode: 0,
        display_luma_ptr: d_luma.as_ptr(),
        display_luma_len: d_luma.len(),
        display_red_ptr: d_red.as_ptr(),
        display_red_len: d_red.len(),
        display_green_ptr: d_green.as_ptr(),
        display_green_len: d_green.len(),
        display_blue_ptr: d_blue.as_ptr(),
        display_blue_len: d_blue.len(),
    };
    let mut output = vec![0f32; lanes];
    let rc = maple_apply_chain_and_encode_display_curves_f32(
        input.as_ptr(),
        w,
        h,
        &p,
        &curves,
        output.as_mut_ptr(),
    );
    assert_eq!(rc, 0, "fused curves chain rc={rc}");

    let rgb: Vec<u8> = output
        .chunks_exact(4)
        .flat_map(|px| [to_byte(px[0]), to_byte(px[1]), to_byte(px[2])])
        .collect();
    let rgb = image::RgbImage::from_raw(w, h, rgb).expect("candidate buffer size");
    resize_long_edge(image::DynamicImage::ImageRgb8(rgb), LONG_EDGE_PX)
        .to_rgb8()
        .save(out)
        .expect("write candidate png");
}

#[test]
#[ignore = "fixture-gated and ~15 min: run with `cargo test -p raw-ffi --lib curves_entry -- --ignored`"]
fn unit_range_knots_through_fused_curves_entry_match_develop_reference() {
    let Some(root) = repo_root() else {
        eprintln!("curves_entry_parity: SKIP-PASS — no test-fixtures dir");
        return;
    };
    let script = root.join("src/scripts/compare_images.py");
    if !python_diff_available(&script) {
        eprintln!("curves_entry_parity: SKIP-PASS — python3 + numpy/PIL/colour unavailable");
        return;
    }
    let raw = root.join("test-fixtures/raws/test_0002.dng");
    if !raw.is_file() {
        eprintln!(
            "curves_entry_parity: SKIP-PASS — fixture {} absent",
            raw.display()
        );
        return;
    }

    let full = sidecar(CURVE_CHILDREN);
    let model = raw_core::xmp::parse(&full).expect("full sidecar parses");
    assert!(!model.tone_curve_luma.is_identity());
    assert!(!model.display_tone_curve_red.is_identity());
    // The sidecar layer hands the model `[0, 1]` knots — the FFI contract.
    for (x, y) in model
        .tone_curve_luma
        .points
        .iter()
        .chain(model.display_tone_curve_red.points.iter())
    {
        assert!(
            (0.0..=1.0).contains(x) && (0.0..=1.0).contains(y),
            "knot ({x}, {y})"
        );
    }

    let tmp = tempfile::tempdir().unwrap();
    let stripped_xmp = tmp.path().join("stripped.xmp");
    std::fs::write(&stripped_xmp, sidecar("")).unwrap();
    let reference = tmp.path().join("reference.png");
    let fixed = tmp.path().join("windows-unit-knots.png");
    let control = tmp.path().join("windows-wire-knots.png");

    reference_png(&raw, &model, &reference);
    unsafe {
        windows_path_png(&raw, &stripped_xmp, &model, 1.0, &fixed);
        windows_path_png(&raw, &stripped_xmp, &model, 255.0, &control);
    }

    let (mean, p95, max) = delta_e(&script, &fixed, &reference);
    let (c_mean, c_p95, c_max) = delta_e(&script, &control, &reference);
    eprintln!(
        "curves_entry_parity[unit knots]: mean={mean:.3} p95={p95:.3} max={max:.3}\n\
         curves_entry_parity[wire knots, pre-#3234]: mean={c_mean:.3} p95={c_p95:.3} max={c_max:.3}"
    );
    if let Ok(keep) = std::env::var("MAPLE_CURVES_PARITY_OUT") {
        let dir = PathBuf::from(keep);
        std::fs::create_dir_all(&dir).unwrap();
        for f in [&reference, &fixed, &control] {
            std::fs::copy(f, dir.join(f.file_name().unwrap())).unwrap();
        }
    }

    assert!(mean <= BUDGET_MEAN, "mean ΔE {mean:.3} > {BUDGET_MEAN}");
    assert!(p95 <= BUDGET_P95, "p95 ΔE {p95:.3} > {BUDGET_P95}");
    assert!(max <= BUDGET_MAX, "max ΔE {max:.3} > {BUDGET_MAX}");
    assert!(
        c_mean > mean,
        "wire-domain knots ({c_mean:.3}) should diverge further from the reference than unit knots ({mean:.3})"
    );
}
