//! Ingest stage (#1156, stitching spec §5.1 / eng design §4).
//!
//! Turns a RAW source frame into the buffer shape the compositing stages
//! consume: **planar** R, G, B `f32` planes in scene-linear Rec.2020 D65
//! (the crate working space — see eng design §4 "no sRGB anywhere in
//! core"), plus a 1-bit-per-pixel [`ValidityMask`]. Pixels come from
//! [`raw_core::decode_for_pano`], which runs the canonical develop chain
//! truncated **before every display-prep stage** (no auto-exposure, no
//! capture sharpening, no view transform) so descriptors and gain solving
//! see unbiased pixels.
//!
//! Validity is created here at decode (eng design §4: "created at decode
//! (sensor margins)"): `decode_for_pano` applies the DNG DefaultCrop,
//! which drops the optical-black border and demosaic margin, so every
//! surviving pixel is valid — the mask starts all-true and is *extended*
//! by later stages (warp marks out-of-frame, etc.).
//!
//! The metadata priors (EXIF focal → pixels, DJI gimbal yaw/pitch/roll)
//! live in [`priors`]; the long-edge-capped feature proxy in [`proxy`].

pub mod priors;
pub mod proxy;

use std::path::Path;

use crate::error::PanoError;
pub use priors::{FramePriors, GimbalPrior};
pub use proxy::proxy_to_long_edge;

/// 1 bit/px validity mask, row-major, bit index `y * width + x` packed
/// into `u64` words. A pixel is either fully valid or fully ignored —
/// no fractional validity (eng design §4).
///
/// Hand-rolled rather than pulling in `bitvec`: the crate needs exactly
/// four operations (fill, get, set, count) and the workspace has a
/// no-new-external-deps policy for this milestone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidityMask {
    width: u32,
    height: u32,
    words: Vec<u64>,
}

impl ValidityMask {
    /// A mask of `width × height` bits, every bit set to `valid`.
    pub fn new_filled(width: u32, height: u32, valid: bool) -> Self {
        let bits = (width as usize) * (height as usize);
        let nwords = bits.div_ceil(64);
        let mut words = vec![if valid { u64::MAX } else { 0u64 }; nwords];
        if valid {
            // Keep the tail bits of the last word zero so popcount-based
            // accounting (`count_valid`) never over-reports.
            let tail = bits % 64;
            if tail != 0 {
                if let Some(last) = words.last_mut() {
                    *last = (1u64 << tail) - 1;
                }
            }
        }
        Self {
            width,
            height,
            words,
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Validity at `(x, y)`. Out-of-bounds reads are a contract violation;
    /// debug builds assert, release builds read as invalid.
    #[inline]
    pub fn get(&self, x: u32, y: u32) -> bool {
        debug_assert!(
            x < self.width && y < self.height,
            "({}, {}) out of bounds",
            x,
            y
        );
        if x >= self.width || y >= self.height {
            return false;
        }
        let idx = (y as usize) * (self.width as usize) + x as usize;
        (self.words[idx / 64] >> (idx % 64)) & 1 == 1
    }

    #[inline]
    pub fn set(&mut self, x: u32, y: u32, valid: bool) {
        debug_assert!(
            x < self.width && y < self.height,
            "({}, {}) out of bounds",
            x,
            y
        );
        if x >= self.width || y >= self.height {
            return;
        }
        let idx = (y as usize) * (self.width as usize) + x as usize;
        let (w, b) = (idx / 64, idx % 64);
        if valid {
            self.words[w] |= 1u64 << b;
        } else {
            self.words[w] &= !(1u64 << b);
        }
    }

    /// Number of valid pixels (popcount over the packed words).
    pub fn count_valid(&self) -> usize {
        self.words.iter().map(|w| w.count_ones() as usize).sum()
    }

    /// True if at least one pixel is valid (cheap early-exit scan).
    ///
    /// Equivalent to `count_valid() > 0` but short-circuits on the first
    /// non-zero word instead of accumulating over the entire mask, so it is
    /// O(1) in the common early-exit case.
    #[inline]
    pub fn any_valid(&self) -> bool {
        self.words.iter().any(|&w| w != 0)
    }

    /// True when every pixel is valid.
    pub fn all_valid(&self) -> bool {
        self.count_valid() == (self.width as usize) * (self.height as usize)
    }
}

/// A planar scene-linear RGB frame + validity: the compositing buffer
/// shape (eng design §4 — planar layout is the GPU/SIMD-friendly choice
/// and matches the WGSL kernel design).
///
/// Color space contract: **Rec.2020 primaries, D65 white point, linear
/// transfer, unbounded** — every producer in this module guarantees it,
/// every consumer may assume it. Planes are row-major, length
/// `width × height` each.
#[derive(Clone, Debug)]
pub struct PlanarImage {
    width: u32,
    height: u32,
    pub r: Vec<f32>,
    pub g: Vec<f32>,
    pub b: Vec<f32>,
    pub validity: ValidityMask,
}

impl PlanarImage {
    /// Planarize a `raw_core` interleaved `[f32; 3]` image. The input must
    /// be in `SceneLinearRec2020` (the only space `decode_for_pano`
    /// produces — debug-asserted).
    ///
    /// Validity: all-true. `decode_for_pano` has already applied the DNG
    /// DefaultCrop, so no sensor-margin pixels survive into this buffer.
    pub fn from_scene_linear(image: &raw_core::Image) -> Self {
        debug_assert_eq!(
            image.space,
            raw_core::ColorSpace::SceneLinearRec2020,
            "pano ingest consumes scene-linear Rec.2020 only"
        );
        let n = image.pixel_count();
        let mut r = Vec::with_capacity(n);
        let mut g = Vec::with_capacity(n);
        let mut b = Vec::with_capacity(n);
        for p in &image.pixels {
            r.push(p[0]);
            g.push(p[1]);
            b.push(p[2]);
        }
        Self {
            width: image.width,
            height: image.height,
            r,
            g,
            b,
            validity: ValidityMask::new_filled(image.width, image.height, true),
        }
    }

    /// Construct from raw planes (compositing-side tests and synthetic
    /// inputs). Panics if the plane or mask shapes disagree.
    pub fn from_planes(
        width: u32,
        height: u32,
        r: Vec<f32>,
        g: Vec<f32>,
        b: Vec<f32>,
        validity: ValidityMask,
    ) -> Self {
        let n = (width as usize) * (height as usize);
        assert_eq!(r.len(), n, "R plane length");
        assert_eq!(g.len(), n, "G plane length");
        assert_eq!(b.len(), n, "B plane length");
        assert_eq!(
            (validity.width(), validity.height()),
            (width, height),
            "mask shape"
        );
        Self {
            width,
            height,
            r,
            g,
            b,
            validity,
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn pixel_count(&self) -> usize {
        (self.width as usize) * (self.height as usize)
    }
}

/// One ingested source frame: pixels in the compositing buffer shape plus
/// the rotation/focal priors and the camera identity (diagnostics, DCP
/// grouping, and the §5.9 export metadata all want it).
#[derive(Clone, Debug)]
pub struct IngestedFrame {
    pub image: PlanarImage,
    pub priors: FramePriors,
    pub camera_make: String,
    pub camera_model: String,
    /// OpcodeList3 corrections applied at decode (#1159) — empty when the
    /// source carries none. Surfaced in the stitch report.
    pub applied_opcodes: Vec<String>,
}

/// Ingest a RAW frame from bytes. `ext` is the lowercase file-extension
/// hint, exactly as in [`raw_core::decode_raw`].
pub fn ingest_bytes(bytes: &[u8], ext: &str) -> Result<IngestedFrame, PanoError> {
    let decoded = raw_core::decode_for_pano(bytes, ext).map_err(|source| PanoError::RawDecode {
        context: format!("<bytes>.{ext}"),
        source,
    })?;
    let image = PlanarImage::from_scene_linear(&decoded.image);
    let priors = FramePriors::from_metadata(&decoded.metadata);
    Ok(IngestedFrame {
        image,
        priors,
        camera_make: decoded.metadata.camera_make,
        camera_model: decoded.metadata.camera_model,
        applied_opcodes: decoded.applied_opcodes,
    })
}

/// Ingest a RAW frame from a file path (reads the bytes, derives the
/// extension hint from the path).
pub fn ingest_file(path: &Path) -> Result<IngestedFrame, PanoError> {
    let bytes = std::fs::read(path).map_err(|e| PanoError::io(path, e))?;
    let ext = ext_hint(path);
    let decoded =
        raw_core::decode_for_pano(&bytes, &ext).map_err(|source| PanoError::RawDecode {
            context: path.display().to_string(),
            source,
        })?;
    let image = PlanarImage::from_scene_linear(&decoded.image);
    let priors = FramePriors::from_metadata(&decoded.metadata);
    Ok(IngestedFrame {
        image,
        priors,
        camera_make: decoded.metadata.camera_make,
        camera_model: decoded.metadata.camera_model,
        applied_opcodes: decoded.applied_opcodes,
    })
}

/// Lightweight frame metadata collected during the decode-and-proxy stage.
///
/// Holds everything needed for feature extraction, match-graph construction,
/// strategy selection, bundle adjustment, and re-decode orchestration — but
/// **not** the full-resolution pixel planes.  Those are decoded on demand in
/// the refinement and composite stages (see `#1254`).
#[derive(Clone, Debug)]
pub struct FrameMeta {
    /// Long-edge-capped proxy (downscaled from the full-res decode).
    pub proxy: PlanarImage,
    /// Scale factor `full_width / proxy_width` (used to up-project proxy
    /// coordinates to full-res in the refinement step).
    pub proxy_scale_x: f64,
    /// Scale factor `full_height / proxy_height`.
    pub proxy_scale_y: f64,
    /// Full-resolution dimensions of the source frame (needed for the
    /// `Camera` intrinsics seed and validity mask construction at
    /// re-decode time).
    pub full_width: u32,
    pub full_height: u32,
    /// EXIF / gimbal priors (focal seed, gimbal attitude).
    pub priors: FramePriors,
    /// Camera make string (surfaced in the stitch report).
    pub camera_make: String,
    /// Camera model string (surfaced in the stitch report).
    pub camera_model: String,
    /// OpcodeList3 corrections applied at decode — surfaced in the stitch
    /// report; empty when the source carries none.
    pub applied_opcodes: Vec<String>,
}

/// Decode `path`, produce the long-edge-capped proxy (side ≤
/// `proxy_long_edge`), and return the lightweight [`FrameMeta`].  The
/// full-resolution pixel buffer is allocated internally for the
/// downscale and then immediately freed — it is **never** returned to
/// the caller, so only the proxy planes are retained.
///
/// This is stage-0's decode path for `#1254`: every frame is decoded
/// once here to produce the proxy and priors; the full-resolution
/// pixels are re-decoded on demand in later stages.
pub fn ingest_file_proxy(path: &Path, proxy_long_edge: u32) -> Result<FrameMeta, PanoError> {
    let bytes = std::fs::read(path).map_err(|e| PanoError::io(path, e))?;
    let ext = ext_hint(path);
    let decoded =
        raw_core::decode_for_pano(&bytes, &ext).map_err(|source| PanoError::RawDecode {
            context: path.display().to_string(),
            source,
        })?;
    // Drop the input file buffer immediately after decode — large DNG files
    // (100 MP ≈ 200 MB compressed) would otherwise remain live until function
    // return, doubling the transient stage-0 RSS (#1254).
    drop(bytes);
    // Build the full-res planar image transiently — only to feed the
    // downscaler.  Drop it before returning.
    let full_image = PlanarImage::from_scene_linear(&decoded.image);
    let full_width = full_image.width();
    let full_height = full_image.height();
    let proxy = proxy::proxy_to_long_edge(&full_image, proxy_long_edge);
    drop(full_image);
    // Immediately drop the raw decoded bytes too — they can be large.
    drop(decoded.image);

    let proxy_scale_x = full_width as f64 / proxy.width() as f64;
    let proxy_scale_y = full_height as f64 / proxy.height() as f64;
    let priors = FramePriors::from_metadata(&decoded.metadata);

    Ok(FrameMeta {
        proxy,
        proxy_scale_x,
        proxy_scale_y,
        full_width,
        full_height,
        priors,
        camera_make: decoded.metadata.camera_make,
        camera_model: decoded.metadata.camera_model,
        applied_opcodes: decoded.applied_opcodes,
    })
}

/// Extract only the priors for a frame — metadata pass, **no develop** —
/// so a many-frame priors table (e.g. all 21 frames of a pano set) stays
/// cheap. Same [`FramePriors`] the full ingest produces.
pub fn extract_priors_file(path: &Path) -> Result<FramePriors, PanoError> {
    let bytes = std::fs::read(path).map_err(|e| PanoError::io(path, e))?;
    let md = raw_core::read_pano_metadata(&bytes, &ext_hint(path)).map_err(|source| {
        PanoError::RawDecode {
            context: path.display().to_string(),
            source,
        }
    })?;
    Ok(FramePriors::from_metadata(&md))
}

/// Lowercase extension hint from a path (rawler's format detection keys
/// off lowercase suffixes — same convention as raw-core's own tests).
fn ext_hint(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #3230: a DNG rawler only rejects via an `assert!` (here a 2×2
    /// `BlackLevelRepeatDim` against a single `BlackLevel` value) must come
    /// out of `ingest_bytes` as a typed `PanoError::RawDecode` wrapping the
    /// raw-core decode error — the per-frame failure `maple-cli pano
    /// stitch` reports — not as a panic through the ingest boundary.
    #[test]
    fn rawler_rejected_dng_is_a_typed_pano_error() {
        let bytes = raw_core::test_support::synth_dng::SyntheticGreyDng {
            black_level_repeat_dim: Some((2, 2)),
            ..Default::default()
        }
        .write_to_bytes();
        let err = ingest_bytes(&bytes, "dng").expect_err("rejected DNG must fail");
        match &err {
            PanoError::RawDecode { context, source } => {
                assert_eq!(context, "<bytes>.dng");
                assert!(
                    matches!(
                        source,
                        raw_core::Error::Decode { .. } | raw_core::Error::DecodePanicked { .. }
                    ),
                    "expected a decode error from raw-core, got {source:?}"
                );
                assert!(
                    err.to_string().contains("panic"),
                    "the caught panic should be in the message: {err}"
                );
            }
            other => panic!("expected PanoError::RawDecode, got {other:?}"),
        }
    }

    #[test]
    fn validity_mask_filled_true_counts_every_pixel() {
        // 65 bits forces a partial tail word — the masking path.
        let m = ValidityMask::new_filled(13, 5, true);
        assert_eq!(m.count_valid(), 65);
        assert!(m.all_valid());
        assert!(m.get(0, 0));
        assert!(m.get(12, 4));
    }

    #[test]
    fn validity_mask_any_valid() {
        // All-false mask: any_valid returns false.
        let m = ValidityMask::new_filled(13, 5, false);
        assert!(!m.any_valid());
        // All-true mask: any_valid returns true.
        let m = ValidityMask::new_filled(13, 5, true);
        assert!(m.any_valid());
        // Single bit set in a multi-word mask: any_valid returns true.
        let mut m = ValidityMask::new_filled(70, 2, false);
        assert!(!m.any_valid());
        m.set(69, 1, true);
        assert!(m.any_valid());
    }

    #[test]
    fn validity_mask_filled_false_counts_zero() {
        let m = ValidityMask::new_filled(13, 5, false);
        assert_eq!(m.count_valid(), 0);
        assert!(!m.all_valid());
        assert!(!m.get(6, 2));
    }

    #[test]
    fn validity_mask_set_and_clear_round_trip() {
        let mut m = ValidityMask::new_filled(70, 2, false);
        m.set(69, 1, true); // last pixel, crosses the word boundary
        assert!(m.get(69, 1));
        assert_eq!(m.count_valid(), 1);
        m.set(69, 1, false);
        assert_eq!(m.count_valid(), 0);
        assert!(!m.get(69, 1));
    }

    #[test]
    fn planarize_preserves_values_and_fills_validity() {
        let mut img = raw_core::Image::new(3, 2, raw_core::ColorSpace::SceneLinearRec2020);
        for (i, p) in img.pixels.iter_mut().enumerate() {
            *p = [i as f32, i as f32 + 0.25, i as f32 + 0.5];
        }
        let planar = PlanarImage::from_scene_linear(&img);
        assert_eq!((planar.width(), planar.height()), (3, 2));
        for i in 0..6 {
            assert_eq!(planar.r[i], i as f32);
            assert_eq!(planar.g[i], i as f32 + 0.25);
            assert_eq!(planar.b[i], i as f32 + 0.5);
        }
        assert!(planar.validity.all_valid());
    }

    #[test]
    fn from_planes_rejects_mismatched_shapes() {
        let mask = ValidityMask::new_filled(2, 2, true);
        let ok = PlanarImage::from_planes(2, 2, vec![0.0; 4], vec![0.0; 4], vec![0.0; 4], mask);
        assert_eq!(ok.pixel_count(), 4);
        let mask = ValidityMask::new_filled(2, 2, true);
        let r = std::panic::catch_unwind(move || {
            PlanarImage::from_planes(2, 2, vec![0.0; 3], vec![0.0; 4], vec![0.0; 4], mask)
        });
        assert!(r.is_err(), "short R plane must panic");
    }
}
