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
        // Every container Maple decodes carries 8-bit sRGB samples; a wider
        // space would have been converted by the decoder.
        "space": "srgb",
        "depth": "uchar",
        "density": sidecars.density,
        "size": bytes.len(),
        "icc": sidecars.icc.as_deref().map(base64),
        "exif": sidecars.exif.as_deref().map(base64),
        "xmp": sidecars.xmp.as_deref().map(base64),
    }))
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
