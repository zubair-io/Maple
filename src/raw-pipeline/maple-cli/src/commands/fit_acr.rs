//! `maple-cli fit-acr` — fit a structured ACR-match model from a dense sweep
//! chart rendered by Adobe Camera Raw.
//!
//! Reads:
//!   --spec          <path>       Spec JSON from `SyntheticSweepChart::spec_to_json()`
//!   --render        <path>@<ev>  ACR-rendered PNG at ACR exposure offset <ev> EV.
//!                                Repeatable; exactly one render must have ev=0.
//!   --acr           <path>       Alias for `--render <path>@0` (backward compat).
//!   --out           <path>       Model JSON output path
//!
//! Prints fit stats to stderr; writes model JSON to --out; exits 0 on success.
//! Exits 1 on any failure (missing files, parse errors, solver failures).
//!
//! This command deliberately does not pull in the PNG decode stack — it reads
//! the PNG via the `png` crate (already in the workspace dep tree) so it has
//! no dependency on the raw pipeline at all.  The solver lives in
//! `raw_core::view::acr_fit` and is `#[cfg(feature = "test-support")]`-gated;
//! `model.rs` types and `apply_model` compile unconditionally.
//!
//! Feature gate: `test-support`.

use std::path::Path;

#[cfg(not(feature = "test-support"))]
pub fn run(
    _spec: &Path,
    _renders: &[(&Path, f32)],
    _out: &Path,
) -> Result<i32, Box<dyn std::error::Error>> {
    Err(
        "fit-acr requires the `test-support` cargo feature (cargo run --features test-support)"
            .into(),
    )
}

#[cfg(feature = "test-support")]
pub fn run(
    spec: &Path,
    renders: &[(&Path, f32)],
    out: &Path,
) -> Result<i32, Box<dyn std::error::Error>> {
    use raw_core::view::acr_fit::{
        parse_spec_json, solve_acr_model_multi, AcrRender, COLS, GUARD, PATCH_SIZE, ROWS,
    };

    // Read spec JSON.
    let spec_json = std::fs::read_to_string(spec)
        .map_err(|e| format!("cannot read spec file {}: {e}", spec.display()))?;
    let specs = parse_spec_json(&spec_json).map_err(|e| format!("spec parse error: {e}"))?;
    eprintln!(
        "[fit-acr] loaded {} patches from {}",
        specs.len(),
        spec.display()
    );

    // Decode all renders.
    let expected_w = (COLS * (PATCH_SIZE + GUARD)) as usize;
    let expected_h = (ROWS * (PATCH_SIZE + GUARD)) as usize;

    let mut decoded: Vec<(Vec<u8>, usize, f32)> = Vec::with_capacity(renders.len());
    for (path, ev) in renders {
        let (png_rgb, png_w, png_h) = decode_png_rgb8(path)?;
        eprintln!(
            "[fit-acr] loaded render {}×{} ev={:+.2} from {}",
            png_w,
            png_h,
            ev,
            path.display()
        );
        if png_w != expected_w || png_h != expected_h {
            return Err(format!(
                "render PNG {} size {png_w}×{png_h} does not match expected {expected_w}×{expected_h}",
                path.display()
            )
            .into());
        }
        decoded.push((png_rgb, png_w, *ev));
    }

    // Build AcrRender slice.
    let acr_renders: Vec<AcrRender<'_>> = decoded
        .iter()
        .map(|(rgb, w, ev)| AcrRender {
            png_rgb: rgb,
            png_w: *w,
            ev: *ev,
        })
        .collect();

    // Run the solver.
    let model =
        solve_acr_model_multi(&specs, &acr_renders).map_err(|e| format!("solver error: {e}"))?;

    eprintln!(
        "[fit-acr] fit complete — patches_used={} patches_clipped={} fit_rms_de={:.4}{}",
        model.stats.patches_used,
        model.stats.patches_clipped,
        model.stats.fit_rms_de,
        model
            .stats
            .overlap_rms_rel
            .map(|v| format!(" overlap_rms_rel={v:.4}"))
            .unwrap_or_default(),
    );

    // Write model JSON.
    let json = model.to_json();
    std::fs::write(out, &json)
        .map_err(|e| format!("cannot write output {}: {e}", out.display()))?;
    eprintln!("[fit-acr] wrote model to {}", out.display());

    Ok(0)
}

/// Decode a PNG file to a flat packed-8-bit-RGB byte array.
/// Returns `(bytes, width, height)`.
#[cfg(feature = "test-support")]
fn decode_png_rgb8(path: &Path) -> Result<(Vec<u8>, usize, usize), Box<dyn std::error::Error>> {
    let f = std::fs::File::open(path)
        .map_err(|e| format!("cannot open PNG {}: {e}", path.display()))?;
    let dec = png::Decoder::new(f);
    let mut reader = dec
        .read_info()
        .map_err(|e| format!("PNG header error: {e}"))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("PNG decode error: {e}"))?;

    let w = info.width as usize;
    let h = info.height as usize;

    // The flat 3-byte stride below is only valid for 8-bit channels; a
    // 16-bit PNG would silently interleave high/low bytes of different
    // pixels and corrupt the fit, so reject it outright.
    if info.bit_depth != png::BitDepth::Eight {
        return Err(format!(
            "unsupported PNG bit depth {:?}; fit-acr requires an 8-bit render \
             (re-export the ACR reference as 8-bit)",
            info.bit_depth
        )
        .into());
    }

    // Normalise to packed RGB if needed.
    let rgb = match info.color_type {
        png::ColorType::Rgb => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgba => {
            let pixels = w * h;
            let mut out = Vec::with_capacity(pixels * 3);
            let src = &buf[..info.buffer_size()];
            for px in 0..pixels {
                out.push(src[px * 4]);
                out.push(src[px * 4 + 1]);
                out.push(src[px * 4 + 2]);
            }
            out
        }
        other => {
            return Err(
                format!("unsupported PNG color type {other:?}; expected RGB or RGBA").into(),
            )
        }
    };
    Ok((rgb, w, h))
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use super::*;

    #[test]
    fn sixteen_bit_png_is_rejected_not_misread() {
        let path = std::env::temp_dir().join("fit_acr_16bit_reject.png");
        let file = std::fs::File::create(&path).expect("create temp png");
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), 2, 2);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Sixteen);
        let mut writer = enc.write_header().expect("write header");
        writer
            .write_image_data(&[0u8; 2 * 2 * 3 * 2])
            .expect("write 16-bit data");
        drop(writer);

        let err = decode_png_rgb8(&path).expect_err("16-bit PNG must be rejected");
        assert!(
            err.to_string().contains("bit depth"),
            "error should name the bit depth: {err}"
        );
        let _ = std::fs::remove_file(&path);
    }
}
