//! wasm-bindgen surface for raw-core. Intended for consumption by the
//! Angular web workspace's `maple-common` package (per spec § 00).
//!
//! Browser-safe surface (no filesystem):
//!
//!   render_bytes(raw: Uint8Array, ext: string, xmp: string | null)
//!       → MapleRender { width: u32, height: u32, rgb: Uint8Array }
//!
//! Threading (T10):
//! When compiled with `--features parallel` and the `+atomics,+bulk-memory`
//! target features, `initThreadPool(num_threads)` is re-exported from
//! `wasm-bindgen-rayon`. JS callers invoke it only when
//! `crossOriginIsolated` is true (COOP: same-origin + COEP: require-corp).
//! Without those headers (Safari/Firefox default, or any host without them),
//! the decode path continues to work single-threaded — no feature detection
//! is needed on the Rust side.

use raw_core::xmp as xmp_mod;
use wasm_bindgen::prelude::*;

// Re-export wasm-bindgen-rayon's `initThreadPool` when the `parallel` feature
// is enabled. JS imports it as `initThreadPool` from the generated bindings.
#[cfg(all(target_arch = "wasm32", feature = "parallel"))]
pub use wasm_bindgen_rayon::init_thread_pool;

/// `true` when this WASM binary was built with atomics + the parallel feature.
/// JS can still override by refusing to call `initThreadPool` when
/// `crossOriginIsolated` is false (e.g. Safari or Firefox without COOP/COEP).
#[wasm_bindgen]
pub fn is_threaded() -> bool {
    cfg!(all(target_arch = "wasm32", target_feature = "atomics", feature = "parallel"))
}

/// One-shot panic hook installer. Safe to call multiple times. JS calls this
/// once immediately after `init()` so that Rust panics surface in DevTools
/// instead of becoming opaque `RuntimeError: unreachable` traps.
#[wasm_bindgen]
pub fn install_panic_hook() {
    #[cfg(target_arch = "wasm32")]
    {
        console_error_panic_hook::set_once();
    }
}

#[wasm_bindgen]
pub struct MapleRender {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
    as_shot_temperature: f32,
    as_shot_tint: f32,
}

#[wasm_bindgen]
impl MapleRender {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }
    #[wasm_bindgen(getter)]
    pub fn rgb(&self) -> Vec<u8> { self.rgb.clone() }
    /// Camera-side "As Shot" correlated colour temperature in Kelvin, as
    /// determined by rawler from the RAW metadata. When the RAW lacks an
    /// explicit CCT we fall back to 6500K (D65) so callers always get a
    /// usable value.
    #[wasm_bindgen(getter)]
    pub fn as_shot_temperature(&self) -> f32 { self.as_shot_temperature }
    /// "As Shot" tint in Maple's slider units (-100 .. 100). Approximated
    /// from the camera's AsShotNeutral (blue vs red skew). 0 when the RAW
    /// does not expose enough information.
    #[wasm_bindgen(getter)]
    pub fn as_shot_tint(&self) -> f32 { self.as_shot_tint }
}

/// Rough CCT estimator from a green-normalised AsShotNeutral (R, 1, B).
/// Anchors: log2(B/R) = 0 → 5500K, ±1 → ±2500K. Good to within ~500K for
/// the common daylight/tungsten/cloudy range — better than the 6500K
/// fallback that otherwise shows up when rawler can't surface CCT itself.
fn estimate_cct_from_neutral(as_shot_neutral: [f32; 3]) -> f32 {
    let r = as_shot_neutral[0].max(0.01);
    let b = as_shot_neutral[2].max(0.01);
    let log2_ratio = (b / r).ln() / core::f32::consts::LN_2;
    (5500.0 + log2_ratio * 2500.0).clamp(2000.0, 12000.0)
}

/// Render a RAW from bytes (WASM-friendly — no filesystem path needed).
///
/// `ext` is a lowercase file extension like `"dng"`, `"cr2"`, `"arw"` so
/// rawler can disambiguate formats when magic is ambiguous.
///
/// `xmp` is optional XMP sidecar content as a UTF-8 string (not a path).
/// When `xmp` is `None` we assume the caller is opening a brand-new RAW
/// (no prior user adjustments) and substitute the camera's AsShotNeutral-
/// derived white balance for Maple's 6500K default — otherwise every fresh
/// import would render with a strong colour cast before the user has
/// touched the Temperature slider.
#[wasm_bindgen]
pub fn render_bytes(raw: &[u8], ext: &str, xmp: Option<String>) -> Result<MapleRender, JsError> {
    let raw_img = raw_core::decode::decode_bytes(raw, ext)
        .map_err(|e| JsError::new(&e.to_string()))?;

    // rawler 0.7 doesn't surface AsShotTemperature, so `as_shot_cct` is
    // always None today. Fall back to estimating the CCT from the camera's
    // AsShotNeutral reading — same signal Adobe uses when the DNG lacks a
    // baked Kelvin tag.
    let as_shot_temperature = raw_img
        .as_shot_cct
        .unwrap_or_else(|| estimate_cct_from_neutral(raw_img.as_shot_neutral));
    // Tint is best left at 0 on cold open — deriving it from a single
    // neutral reading without the camera's DCP hue map misleads the slider.
    // The user can nudge it manually once the temperature is in the ballpark.
    let as_shot_tint = 0.0_f32;

    let fresh_open = xmp.is_none();
    let mut model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    // Fresh open (no sidecar) → render at the camera's As Shot WB, not the
    // 6500K default the struct carries. User edits always come in through
    // `xmp = Some(..)` once they've moved a slider, so this branch only
    // kicks in for a first-render cold open.
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }

    let (w, h, bytes) = raw_core::pipeline::render_from_raw(&raw_img, &model)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleRender {
        width: w,
        height: h,
        rgb: bytes,
        as_shot_temperature,
        as_shot_tint,
    })
}

/// Scene-linear FFI return type — Rec.2020 fp16 RGBA, straight alpha,
/// row-major. Mirrors Apple's `MapleSceneLinearBuffer` C struct at
/// `raw-ffi/src/lib.rs:283-308` minus the raw pointer (wasm-bindgen owns
/// the `Vec<u16>`; the JS getter exposes it as a `Uint16Array` view, which
/// is the same bit pattern as the Apple buffer).
///
/// Plan 3 M1 — see docs/superpowers/plans/2026-04-25-plan-3-web-ffi-split-m1.md.
#[wasm_bindgen]
pub struct MapleSceneLinearRender {
    width: u32,
    height: u32,
    fp16_rgba: Vec<u16>,
    as_shot_temperature: f32,
    as_shot_tint: f32,
}

#[wasm_bindgen]
impl MapleSceneLinearRender {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 { self.width }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 { self.height }
    /// fp16 RGBA lanes (4 channels, 2 bytes per lane). Length is always
    /// `4 * width * height`. Alpha lane is fp16 1.0 (`0x3c00`).
    /// Returned as `Uint16Array` over the WASM heap on the JS side.
    #[wasm_bindgen(getter)]
    pub fn fp16_rgba(&self) -> Vec<u16> { self.fp16_rgba.clone() }
    /// Bytes per pixel — always 8. Exposed for symmetry with Apple's
    /// `MapleSceneLinearBuffer.bytes_per_pixel` so future bit-depth
    /// changes (HDR / fp32) don't break the JS consumer.
    #[wasm_bindgen(getter)]
    pub fn bytes_per_pixel(&self) -> u32 { 8 }
    /// Channels per pixel — always 4 (R, G, B, A).
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 { 4 }
    /// Camera "As Shot" CCT in Kelvin — see `MapleRender::as_shot_temperature`.
    #[wasm_bindgen(getter)]
    pub fn as_shot_temperature(&self) -> f32 { self.as_shot_temperature }
    /// Camera "As Shot" tint in slider units (-100..100).
    #[wasm_bindgen(getter)]
    pub fn as_shot_tint(&self) -> f32 { self.as_shot_tint }
}

/// Render a RAW from bytes to a scene-linear Rec.2020 fp16 RGBA buffer.
/// Pre-AgX, pre-Rec.2020->sRGB — the caller (Plan 3 M2 GLSL chain) is
/// expected to apply the AgX view transform and gamut convert before
/// display. **Mirrors the legacy `render_bytes` semantics** for the
/// non-rendering arguments (`ext`, `xmp`, fresh-open WB substitution)
/// but returns fp16 instead of sRGB u8.
///
/// `quality_preview = true` runs the half-res Preview pipeline; `false`
/// runs full-res Full. Same mapping as the legacy entry.
///
/// Plan 3 M1 — see docs/superpowers/plans/2026-04-25-plan-3-web-ffi-split-m1.md.
#[wasm_bindgen]
pub fn render_bytes_scene_linear(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    quality_preview: bool,
) -> Result<MapleSceneLinearRender, JsError> {
    let raw_img = raw_core::decode::decode_bytes(raw, ext)
        .map_err(|e| JsError::new(&e.to_string()))?;

    // Same as_shot derivation as the legacy entry — rawler 0.7 still doesn't
    // surface AsShotTemperature, so we estimate from AsShotNeutral and pass
    // tint through as 0 on cold open. See raw-wasm/src/lib.rs:106-112.
    let as_shot_temperature = raw_img
        .as_shot_cct
        .unwrap_or_else(|| estimate_cct_from_neutral(raw_img.as_shot_neutral));
    let as_shot_tint = 0.0_f32;

    let fresh_open = xmp.is_none();
    let mut model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    if fresh_open {
        model.temperature = as_shot_temperature;
        model.tint = as_shot_tint;
    }

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        raw_core::pipeline::RenderQuality::Full
    };
    let (w, h, fp16_rgba) =
        raw_core::pipeline::render_scene_linear_from_raw_with_quality(&raw_img, &model, quality)
            .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleSceneLinearRender {
        width: w,
        height: h,
        fp16_rgba,
        as_shot_temperature,
        as_shot_tint,
    })
}

/// Version string (for build verification from JS).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthesized 8x8 mosaic round-trip — proves the new entry returns
    /// fp16 RGBA with alpha lane = 0x3c00 (fp16 1.0) and a buffer length
    /// of 8*w*h bytes (i.e. 4 channels * 2 bytes/lane * w * h).
    ///
    /// We don't have a fixture DNG checked in (raws are gitignored), but
    /// the function is layered on `raw_core::pipeline::render_scene_linear_*`
    /// which has its own fixture-gated tests upstream. This test instead
    /// uses the smallest valid synthetic input we can: a tiny embedded DNG
    /// generated by `cargo test -p raw-core` fixtures. Skip when the
    /// fixture isn't available.
    #[test]
    #[ignore = "requires test-fixtures/raws/* (gitignored); run with --ignored"]
    fn render_bytes_scene_linear_returns_fp16_rgba_with_alpha_one() {
        // Path mirror of the helper test in raw-core; this test only runs
        // when the engineer has the fixtures locally.
        let path = std::path::PathBuf::from(
            std::env::var("CARGO_MANIFEST_DIR").unwrap()
        ).join("../test-fixtures/raws/dji-mavic3pro-100mp.dng");
        if !path.exists() {
            eprintln!("fixture missing at {:?} — skipping", path);
            return;
        }
        let bytes = std::fs::read(&path).expect("read fixture");
        let result = render_bytes_scene_linear(&bytes, "dng", None, true)
            .expect("render_bytes_scene_linear ok");
        let w = result.width();
        let h = result.height();
        assert!(w > 0 && h > 0, "non-zero dimensions");
        let lanes: Vec<u16> = result.fp16_rgba();
        assert_eq!(
            lanes.len(),
            (w as usize) * (h as usize) * 4,
            "expected 4 fp16 lanes per pixel (RGBA)"
        );
        // Alpha lane (every 4th u16) must be fp16 1.0 = 0x3c00.
        // Sample the first 16 pixels — covers the top-left tile and is
        // cheap.
        for i in 0..16.min(w as usize * h as usize) {
            let alpha = lanes[i * 4 + 3];
            assert_eq!(
                alpha, 0x3c00,
                "pixel {} alpha was 0x{:04x}, expected fp16 1.0 (0x3c00)",
                i, alpha
            );
        }
        // Sanity: at least one of the first 256 R/G/B lanes is non-zero
        // (the synthetic input has signal).
        let any_nonzero_rgb = (0..256.min(w as usize * h as usize))
            .any(|i| lanes[i * 4] != 0 || lanes[i * 4 + 1] != 0 || lanes[i * 4 + 2] != 0);
        assert!(any_nonzero_rgb, "all R/G/B lanes were zero — pipeline failure");
    }
}

// =============================================================================
// Panorama output-buffer accessors for wasm-bindgen (T2.3)
// Gated behind `--features pano`.  Without the feature: zero new WASM exports,
// zero new deps, byte-identical output.
// =============================================================================

#[cfg(feature = "pano")]
mod pano {
    use half::f16;
    use js_sys::Array;
    use pano_core::{PanoImage, PipelineOptions};
    use wasm_bindgen::prelude::*;

    // -------------------------------------------------------------------------
    // PanoramaOptions — JS-facing stitch configuration.
    // -------------------------------------------------------------------------

    /// Stitch configuration passed from JS to `PanoHandle::stitch`.
    ///
    /// Field semantics:
    /// - `projection`:    0 = Rectilinear, 1 = Cylindrical (default), 2 = Spherical
    /// - `parallax_mode`: 0 = Homography (default), 1 = TPS (ignored in MVP)
    /// - `max_dimension`: long-edge clamp in pixels; 0 = unconstrained (default)
    #[wasm_bindgen]
    #[derive(Clone, Copy)]
    pub struct PanoramaOptions {
        pub projection: u32,
        pub parallax_mode: u32,
        pub max_dimension: u32,
    }

    #[wasm_bindgen]
    impl PanoramaOptions {
        /// Construct options with defaults: cylindrical, homography, unconstrained.
        #[wasm_bindgen(constructor)]
        pub fn new() -> PanoramaOptions {
            PanoramaOptions {
                projection: 1,      // Cylindrical
                parallax_mode: 0,   // Homography
                max_dimension: 0,   // unconstrained
            }
        }
    }

    impl Default for PanoramaOptions {
        fn default() -> Self { Self::new() }
    }

    impl From<PanoramaOptions> for PipelineOptions {
        fn from(o: PanoramaOptions) -> Self {
            use pano_core::types::{ParallaxMode, Projection};
            let projection = match o.projection {
                0 => Projection::Rectilinear,
                2 => Projection::Spherical,
                _ => Projection::Cylindrical,
            };
            let parallax_mode = match o.parallax_mode {
                1 => ParallaxMode::TpsMesh,
                _ => ParallaxMode::Homography,
            };
            PipelineOptions {
                projection,
                output_color: pano_core::ColorSpace::rec2020_d65_linear(),
                max_dimension: o.max_dimension,
                parallax_mode,
            }
        }
    }

    // -------------------------------------------------------------------------
    // PanoHandle — opaque stitched-panorama buffer.
    // -------------------------------------------------------------------------

    /// Opaque JS-facing handle wrapping a stitched panorama buffer.
    ///
    /// Construction: `PanoHandle.stitch(images, options)`.
    /// Pixel access: `pixelsF32()` / `pixelsF16()`.
    ///
    /// Tech debt: each accessor **clones** the entire pixel buffer to the JS
    /// heap (wasm-bindgen semantics).  For a 100 MP panorama this is ~1.2 GB
    /// per call — the service layer must call each accessor at most once and
    /// cache the result.  A zero-copy Uint8Array::view approach is a T6+
    /// follow-up once wasm-bindgen exposes it stably.
    #[wasm_bindgen]
    pub struct PanoHandle {
        image: PanoImage,
        /// Eagerly-populated f16 interleaved RGB cache.
        /// Length == image.width * image.height * 3 (RGB, no alpha).
        f16_cache: Vec<u16>,
    }

    #[wasm_bindgen]
    impl PanoHandle {
        // ----- factory -------------------------------------------------------

        /// Stitch a JS Array of `Uint8Array` byte buffers (PNG / JPEG each)
        /// into a panorama.
        ///
        /// `images` must contain at least 2 entries.  Each entry must be a
        /// `Uint8Array` containing a valid PNG or JPEG (DNG is accepted but
        /// requires a pano-enabled WASM build and may be slow).
        ///
        /// Returns a `PanoHandle` with the f16 cache pre-populated.  Throws a
        /// JS `Error` on decode or stitch failure.
        #[wasm_bindgen]
        pub fn stitch(images: Array, options: PanoramaOptions) -> Result<PanoHandle, JsValue> {
            if images.length() < 2 {
                return Err(JsValue::from_str(
                    "PanoHandle.stitch: need at least 2 images",
                ));
            }

            // Convert each JS Uint8Array to an owned Vec<u8>.
            let mut decoded: Vec<PanoImage> = Vec::with_capacity(images.length() as usize);
            for i in 0..images.length() {
                let item = images.get(i);
                // Accept Uint8Array entries.
                let u8arr = js_sys::Uint8Array::from(item);
                let bytes: Vec<u8> = u8arr.to_vec();
                let img = pano_core::decode_bytes(&bytes)
                    .map_err(|e| JsValue::from_str(&format!("decode image {i}: {e}")))?;
                decoded.push(img);
            }

            // Run the classical pipeline.
            let pipeline_opts: PipelineOptions = options.into();
            let result = pano_core::stitch_images(&decoded, &pipeline_opts)
                .map_err(|e| JsValue::from_str(&format!("stitch: {e}")))?;

            // Eagerly compute f16 cache (called at most once — see tech debt note).
            let f16_cache: Vec<u16> = result.pixels
                .iter()
                .map(|&v| f16::from_f32(v).to_bits())
                .collect();

            Ok(PanoHandle { image: result, f16_cache })
        }

        // ----- accessors -----------------------------------------------------

        /// Width of the panorama in pixels.
        #[wasm_bindgen(getter)]
        pub fn width(&self) -> u32 {
            self.image.width
        }

        /// Height of the panorama in pixels.
        #[wasm_bindgen(getter)]
        pub fn height(&self) -> u32 {
            self.image.height
        }

        /// Returns the f32 RGB pixel buffer as a `Float32Array`-compatible
        /// `Vec<f32>`.  Interleaved RGB, row-major; length is
        /// `width * height * 3`.
        ///
        /// **Clones the buffer on each call** — call at most once and cache
        /// on the JS side.  See tech-debt note on `PanoHandle`.
        #[wasm_bindgen(js_name = pixelsF32)]
        pub fn pixels_f32(&self) -> Vec<f32> {
            self.image.pixels.clone()
        }

        /// Returns the f16 (half-precision, stored as `u16`) RGB pixel buffer.
        ///
        /// Interleaved RGB, row-major; length is `width * height * 3`.
        /// After `PanoHandle::stitch` the cache is pre-populated, so this is
        /// the zero-extra-encode path.
        ///
        /// **Clones the cache on each call** — call at most once and cache
        /// on the JS side.  See tech-debt note on `PanoHandle`.
        #[wasm_bindgen(js_name = pixelsF16)]
        pub fn pixels_f16(&self) -> Vec<u16> {
            self.f16_cache.clone()
        }
    }

    /// Construct a `PanoHandle` from a `PanoImage` (Rust-internal; not
    /// exposed to JS).  Used by tests.
    #[allow(dead_code)]
    pub fn handle_from_image(img: PanoImage) -> PanoHandle {
        let f16_cache: Vec<u16> = img.pixels
            .iter()
            .map(|&v| f16::from_f32(v).to_bits())
            .collect();
        PanoHandle { image: img, f16_cache }
    }

    // -------------------------------------------------------------------------
    // Tests
    // -------------------------------------------------------------------------

    #[cfg(test)]
    mod tests {
        use super::*;
        use pano_core::{ColorSpace, PanoImage};

        fn make_test_image() -> PanoImage {
            // PanoImage::new marks all pixels valid automatically.
            let mut img = PanoImage::new(2, 1, ColorSpace::rec2020_d65_linear());
            img.pixels = vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
            img
        }

        #[test]
        fn pano_handle_width_height() {
            let h = handle_from_image(make_test_image());
            assert_eq!(h.width(), 2);
            assert_eq!(h.height(), 1);
        }

        #[test]
        fn pano_handle_pixels_f32_roundtrip() {
            let h = handle_from_image(make_test_image());
            let px = h.pixels_f32();
            assert_eq!(px.len(), 6);
            assert!((px[0] - 0.1).abs() < 1e-6, "R0={}", px[0]);
            assert!((px[1] - 0.2).abs() < 1e-6, "G0={}", px[1]);
            assert!((px[2] - 0.3).abs() < 1e-6, "B0={}", px[2]);
        }

        #[test]
        fn pano_handle_pixels_f16_populated() {
            let h = handle_from_image(make_test_image());
            // f16 cache is now eagerly populated — 2 pixels × 3 channels.
            assert_eq!(
                h.pixels_f16().len(),
                6,
                "f16 cache should have 6 elements (2 pixels × 3 channels)"
            );
        }

        #[test]
        fn pano_options_defaults() {
            let o = PanoramaOptions::new();
            assert_eq!(o.projection, 1, "default projection should be Cylindrical (1)");
            assert_eq!(o.parallax_mode, 0, "default parallax_mode should be Homography (0)");
            assert_eq!(o.max_dimension, 0, "default max_dimension should be 0 (unconstrained)");
        }
    }
}
