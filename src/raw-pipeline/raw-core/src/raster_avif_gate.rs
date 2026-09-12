//! Feature gate so the AVIF branch compiles to a clean error when raw-core is
//! built without `avif` (raw-wasm), and to the real decoder otherwise.
//!
//! Split out of `raster.rs` (#3507) once the controller-ruling fix to
//! `RasterMetadata` — a real header probe for `channels`/`has_alpha`,
//! replacing the old hard-coded `channels: 3` — pushed that file over the
//! 600-line hard budget.

use super::*;

/// Container-level facts needed by `probe_raster_metadata`, mirrored from
/// `avif_decode::AvifProbe` so this module has a concrete return type
/// whether or not the `avif_decode` module exists in this build.
pub(crate) struct AvifProbeLite {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
}

#[cfg(feature = "avif")]
pub(crate) fn decode(bytes: &[u8]) -> Result<RasterImage> {
    crate::avif_decode::decode_avif(bytes)
}
#[cfg(not(feature = "avif"))]
pub(crate) fn decode(_bytes: &[u8]) -> Result<RasterImage> {
    Err(Error::Decode {
        path: "<memory>".into(),
        reason: "AVIF decoding requires the `avif` feature".into(),
    })
}

#[cfg(feature = "avif")]
pub(crate) fn probe(bytes: &[u8]) -> Result<AvifProbeLite> {
    let probe = crate::avif_decode::probe_avif(bytes)?;
    Ok(AvifProbeLite {
        width: probe.width,
        height: probe.height,
        has_alpha: probe.has_alpha,
    })
}
#[cfg(not(feature = "avif"))]
pub(crate) fn probe(_bytes: &[u8]) -> Result<AvifProbeLite> {
    Err(Error::Decode {
        path: "<memory>".into(),
        reason: "AVIF probing requires the `avif` feature".into(),
    })
}
