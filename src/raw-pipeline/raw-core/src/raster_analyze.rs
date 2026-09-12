//! The read-only half of the raster surface (#3507): one function that
//! answers a small JSON request with a small JSON reply.
//!
//! Request: `{"v":1,"what":["metadata","stats"]}`. `metadata` is the cheap
//! header probe (`raster::probe_raster_metadata`) plus the container's
//! metadata blocks (`raster_meta::read_sidecars`); `stats` decodes the
//! pixels (`raster::decode_raster`) and runs `raster_stats::compute_stats`.
//! Asking for only `metadata` never decodes.
//!
//! EXIF, ICC and XMP come back base64-encoded, because the reply is one JSON
//! document and those blocks are binary. They are small (an ICC profile is a
//! few KB, an EXIF block tens of KB), so the ~33% encoding overhead is not
//! worth a second out-buffer and a second round of size probing.
//!
//! `channels`/`hasAlpha` come straight from `RasterMetadata::channels`/
//! `RasterMetadata::has_alpha` (#3507 controller ruling fixed the field
//! itself, which used to be hard-coded to `3` for every non-AVIF format —
//! this module's own local re-probe, `channels_and_alpha`, existed only to
//! route around that and is gone now that the shared field is correct).

use crate::error::{Error, Result};
use crate::raster_stats::{compute_stats, RasterStats};
use image::ImageDecoder;
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnalyzeRequest {
    v: u32,
    what: Vec<String>,
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding. Written here rather than pulled in as a
/// crate: it is twenty lines, the alternative is a new dependency and a
/// vendor commit, and the only consumer is this reply.
pub(crate) fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let packed = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, &b)| acc | (b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(BASE64_ALPHABET[((packed >> (18 - 6 * i)) & 0x3F) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn bad(reason: String) -> Error {
    Error::Decode {
        path: "<analyze>".into(),
        reason,
    }
}

/// Drop a metadata block that exceeds [`crate::raster_meta::MAX_SIDECAR_BYTES`].
///
/// Every block in this reply is base64'd into one JSON document that then
/// crosses the FFI through a 64 KB size probe and a second, full-size
/// buffer, so an oversized block costs ~2.3× its own size in transient
/// allocation on both sides of the boundary. See that constant's doc for
/// the ceiling and why an over-cap block is reported absent rather than as
/// an error (#3507 final fix wave, item 5).
fn capped(block: Option<&[u8]>) -> Option<&[u8]> {
    block.filter(|b| b.len() <= crate::raster_meta::MAX_SIDECAR_BYTES)
}

fn metadata_value(bytes: &[u8]) -> Result<Value> {
    let probe = crate::raster::probe_raster_metadata(bytes)?;
    let sidecars = crate::raster_meta::read_sidecars(bytes);
    Ok(json!({
        "width": probe.width,
        "height": probe.height,
        "format": probe.format,
        "channels": probe.channels,
        "orientation": probe.orientation,
        "hasAlpha": probe.has_alpha,
        "hasProfile": sidecars.icc.is_some(),
        // Every container Maple decodes is sRGB (a wider space would have
        // been converted by the decoder) — but sample *depth* genuinely
        // varies: TIFF and PNG can carry 16-bit-per-channel samples, unlike
        // this crate's JPEG/WebP/AVIF encoders, which are always 8-bit.
        "space": "srgb",
        "depth": depth_value(bytes, &probe.format),
        "density": sidecars.density,
        "size": bytes.len(),
        "icc": capped(sidecars.icc.as_deref()).map(base64),
        // Handed back in the form the container stored it, introducer and
        // all, because that is what sharp returns (#3507 final fix wave,
        // item 3 — see `RasterSidecars::exif_as_stored`).
        "exif": capped(sidecars.exif_as_stored().as_deref()).map(base64),
        "xmp": capped(sidecars.xmp.as_deref()).map(base64),
    }))
}

/// Sample depth ('uchar' / 'ushort', matching sharp's own `metadata().depth`
/// vocabulary), read from the container header rather than assumed.
///
/// Only TIFF and PNG in this crate's supported formats can carry samples
/// wider than 8 bits per channel — `image`'s JPEG and WebP decoders always
/// produce 8-bit output, and AVIF here goes through `avif_decode_gate`
/// rather than `image::ImageReader`, so none of those three need (or can
/// use) a header read; they stay 'uchar'. A decoder-construction failure —
/// after `probe_raster_metadata` already succeeded above — shouldn't happen
/// in practice; falls back to 'uchar' rather than turning an advisory field
/// into a hard error.
fn depth_value(bytes: &[u8], format: &str) -> &'static str {
    if format != "tiff" && format != "dng" && format != "png" {
        return "uchar";
    }
    match image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_decoder().ok())
    {
        Some(decoder) => match decoder.color_type() {
            image::ColorType::L16
            | image::ColorType::La16
            | image::ColorType::Rgb16
            | image::ColorType::Rgba16 => "ushort",
            _ => "uchar",
        },
        None => "uchar",
    }
}

fn stats_value(stats: &RasterStats) -> Value {
    let channels: Vec<Value> = stats
        .channels
        .iter()
        .map(|c| {
            json!({
                "min": c.min,
                "max": c.max,
                "sum": c.sum,
                "squaresSum": c.squares_sum,
                "mean": c.mean,
                "stdev": c.stdev,
                "minX": c.min_x,
                "minY": c.min_y,
                "maxX": c.max_x,
                "maxY": c.max_y,
            })
        })
        .collect();
    json!({
        "channels": channels,
        "isOpaque": stats.is_opaque,
        "entropy": stats.entropy,
        "sharpness": stats.sharpness,
        "dominant": {
            "r": stats.dominant[0],
            "g": stats.dominant[1],
            "b": stats.dominant[2],
        },
    })
}

/// Answer an analyze `request` (schema v1, see the module doc) about
/// `bytes`, returning the JSON reply as a string.
pub fn analyze(bytes: &[u8], request: &str) -> Result<String> {
    let request: AnalyzeRequest = serde_json::from_str(request)
        .map_err(|e| bad(format!("analyze request parse failed: {e}")))?;
    if request.v != 1 {
        return Err(bad(format!(
            "analyze request version {} is not supported (this build speaks version 1)",
            request.v
        )));
    }
    let mut reply = Map::new();
    for what in &request.what {
        match what.as_str() {
            "metadata" => {
                reply.insert("metadata".into(), metadata_value(bytes)?);
            }
            "stats" => {
                let raster = crate::raster::decode_raster(bytes, None)?;
                reply.insert("stats".into(), stats_value(&compute_stats(&raster)?));
            }
            other => return Err(bad(format!("unknown analyze request '{other}'"))),
        }
    }
    serde_json::to_string(&Value::Object(reply))
        .map_err(|e| bad(format!("analyze reply serialisation failed: {e}")))
}

#[cfg(test)]
#[path = "raster_analyze_tests.rs"]
mod tests;
