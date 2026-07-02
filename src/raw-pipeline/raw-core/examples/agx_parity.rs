//! Generate the AgX parity reference image.
//!
//! Emits a raw f32 × 3 × W × H scene-linear input and its AgX output,
//! covering the log domain from MID_GRAY·2^MIN_EV to MID_GRAY·2^MAX_EV.
//! Swift / GLSL parity tests load this pair, re-render input through
//! their own AgX implementation, and diff against the Rust output at
//! ≤ 1e-4 per channel (spec § 06-cross-platform § AgX parity tolerance).
//!
//! Usage:
//!   cargo run -p raw-core --example agx_parity -- <out_dir>
//!
//! Writes:
//!   <out_dir>/agx_parity_in.f32   — 256 × 256 × 3 scene-linear f32 (LE)
//!   <out_dir>/agx_parity_out.f32  — 256 × 256 × 3 display-linear f32 (LE)
//!   <out_dir>/agx_parity.json     — header: {width, height, min_ev, max_ev, version}

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

use raw_core::image::{ColorSpace, Image};
use raw_core::view::agx::{AGX_MAX_EV, AGX_MID_GRAY, AGX_MIN_EV, AGX_VERSION};

const W: usize = 256;
const H: usize = 256;

fn main() -> std::io::Result<()> {
    let out_dir: PathBuf = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/agx-parity"));
    std::fs::create_dir_all(&out_dir)?;

    // X axis: log-EV sweep across [MIN_EV, MAX_EV].
    // Y axis: per-channel offset — red/green/blue each vary independently
    // so the fixture exercises gamut-compression behavior.
    let mut pixels = Vec::with_capacity(W * H);
    for y in 0..H {
        let ty = (y as f32) / ((H - 1) as f32);
        for x in 0..W {
            let tx = (x as f32) / ((W - 1) as f32);
            let ev = AGX_MIN_EV + tx * (AGX_MAX_EV - AGX_MIN_EV);
            let scene = AGX_MID_GRAY * ev.exp2();
            // R: flat; G: 0.5× factor scaled by Y; B: 2× factor scaled by Y.
            // This produces out-of-gamut channel pairs at the extremes.
            let r = scene;
            let g = scene * (1.0 - ty * 0.5);
            let b = scene * (1.0 + ty * 1.0);
            pixels.push([r, g, b]);
        }
    }

    // Write input f32s.
    let mut f_in = File::create(out_dir.join("agx_parity_in.f32"))?;
    for p in &pixels {
        for &c in p {
            f_in.write_all(&c.to_le_bytes())?;
        }
    }

    // Run AgX.
    let mut img = Image::new(W as u32, H as u32, ColorSpace::SceneLinearRec2020);
    img.pixels.copy_from_slice(&pixels);
    raw_core::view::agx::apply(&mut img, 0.0);

    // Write output f32s.
    let mut f_out = File::create(out_dir.join("agx_parity_out.f32"))?;
    for p in &img.pixels {
        for &c in p {
            f_out.write_all(&c.to_le_bytes())?;
        }
    }

    // Write metadata JSON.
    let meta = format!(
        "{{\"width\":{},\"height\":{},\"min_ev\":{},\"max_ev\":{},\"mid_gray\":{},\"version\":{}}}\n",
        W, H, AGX_MIN_EV, AGX_MAX_EV, AGX_MID_GRAY, AGX_VERSION
    );
    File::create(out_dir.join("agx_parity.json"))?.write_all(meta.as_bytes())?;

    eprintln!("wrote agx_parity_in.f32 ({} bytes)", W * H * 3 * 4);
    eprintln!("wrote agx_parity_out.f32 ({} bytes)", W * H * 3 * 4);
    eprintln!("wrote agx_parity.json (version {})", AGX_VERSION);
    Ok(())
}
