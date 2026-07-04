//! `maple-cli tile` — render one source-pixel tile to a viewable PNG. The
//! fp16 RGBA produced by the FFI tile path is decoded back to f32 here and
//! run through the legacy CPU view tail (AgX + Rec.2020→sRGB + quantize +
//! Look) so the resulting PNG opens directly in Preview.app. This is a
//! sanity check on the tile math, not a parity gate.

use raw_core::decode::decode_bytes;
use raw_core::pipeline::{render_scene_linear_tile_from_raw_with_quality, RenderQuality, TileRect};
use raw_core::xmp;
use std::path::Path;

#[allow(clippy::too_many_arguments)]
pub fn run(
    raw: &Path,
    params: Option<&Path>,
    src_x: u32,
    src_y: u32,
    src_w: u32,
    src_h: u32,
    out_w: u32,
    out_h: u32,
    out: &Path,
    quality: &str,
) -> Result<i32, Box<dyn std::error::Error>> {
    let model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };
    let bytes = std::fs::read(raw)?;
    let ext = raw.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw_img = decode_bytes(&bytes, ext)?;
    let q = match quality {
        "preview" => RenderQuality::Preview,
        "full" => RenderQuality::Full,
        "amaze" => RenderQuality::Amaze,
        other => {
            return Err(format!(
                "invalid quality '{}': use 'preview', 'full', or 'amaze'",
                other
            )
            .into())
        }
    };
    let (w, h, fp16) = render_scene_linear_tile_from_raw_with_quality(
        &raw_img,
        &model,
        TileRect {
            src_x,
            src_y,
            src_w,
            src_h,
            out_w,
            out_h,
        },
        q,
    )?;
    // Decode fp16 → f32, build an Image, run the legacy view tail (AgX +
    // Rec.2020→sRGB + quantize) so we can write a viewable PNG.
    let mut img =
        raw_core::image::Image::new(w, h, raw_core::image::ColorSpace::SceneLinearRec2020);
    for (i, p) in img.pixels.iter_mut().enumerate() {
        let r = decode_fp16(fp16[i * 4]);
        let g = decode_fp16(fp16[i * 4 + 1]);
        let b = decode_fp16(fp16[i * 4 + 2]);
        *p = [r, g, b];
    }
    raw_core::view::agx::apply(&mut img, model.contrast);
    raw_core::view::encode::rec2020_to_srgb(&mut img);
    raw_core::view::encode::srgb_gamma_encode(&mut img);
    // No per-pixel Look pass: #443 retired the static Look LUT, matching
    // `render_from_raw_with_quality`'s view-tail (Auto Profile owns
    // view-shaping). `tile` previews still match `batch` / live FFI.
    let u8_bytes = raw_core::view::encode::dither_and_quantize(&mut img);
    let png = raw_core::png::encode(w, h, &u8_bytes)?;
    std::fs::write(out, png)?;
    Ok(0)
}

/// Local fp16 → f32 decoder for the CLI tile path. Mirrors the inverse of
/// `pipeline::f32_to_f16_bits`.
fn decode_fp16(bits: u16) -> f32 {
    let sign = ((bits & 0x8000) as u32) << 16;
    let exp = ((bits & 0x7c00) >> 10) as u32;
    let mant = (bits & 0x03ff) as u32;
    if exp == 0 && mant == 0 {
        return f32::from_bits(sign);
    }
    if exp == 0 {
        // Subnormal — find the leading 1 and re-bias.
        let mut e: i32 = -14;
        let mut m = mant;
        while (m & 0x0400) == 0 {
            m <<= 1;
            e -= 1;
        }
        m &= 0x03ff;
        let f = sign | (((127 + e) as u32) << 23) | (m << 13);
        return f32::from_bits(f);
    }
    if exp == 0x1f {
        return f32::from_bits(sign | 0x7f800000 | (mant << 13));
    }
    let e = (exp + 127 - 15) << 23;
    f32::from_bits(sign | e | (mant << 13))
}
