//! Embedded-RAW-preview extraction, exposed to the Angular `maple-common`
//! package via wasm-bindgen (#2010, epic #1993 Stage 4).
//!
//! Web's "unedited preview" tier (the higher-res still the Preview screen
//! swaps in over the grid thumbnail while the full editor loads) used to be
//! synthesized by decoding + developing the whole RAW and downscaling the
//! result on a canvas — a completely different derivation from what
//! Apple/server do (`raw-ffi/src/thumbnail.rs`'s
//! `maple_render_thumbnail_preview_jpeg_to_file`), which extract the JPEG a
//! camera (or the DNG converter) already baked into the file at capture
//! time. This binding closes that gap: it's a thin wasm-bindgen wrapper
//! around the same shared core (`raw_core::preview::extract_embedded_preview`
//! and `raw_core::preview::resize_long_edge`) raw-ffi's native externs use,
//! so all three platforms derive this tier identically. See that module's
//! doc comment for the extraction algorithm (rawler's `preview_image`,
//! `full_image`, `thumbnail_image` slot hunt) and orientation handling.
//!
//! **JPEG, not AVIF** — unlike the native 256px grid-thumbnail tier
//! (`maple_render_thumbnail_avif_to_file`), this entry always emits JPEG.
//! raw-core's `avif` feature (`image` crate's pure-Rust `ravif`/`rav1e`
//! encoder) is deliberately NOT enabled for `raw-wasm`'s dependency on
//! `raw-core` (see `raw-core/Cargo.toml`'s `avif` feature comment: kept off
//! specifically so raw-wasm never pulls the AV1 encoder into the wasm32
//! build) — turning it on just for this one binding would reverse an
//! already-made, documented architectural call for a single caller, which
//! this ticket doesn't need to relitigate. JPEG is an accepted format for
//! this cache tier already: web's local `.maple/thumbs/` cache already
//! tolerates a JPEG/AVIF split per source (`MapleCacheService`'s
//! `THUMB_READ_ORDER`), and raw-ffi's own 1280px VLM-describe preview tier
//! is JPEG-only for an analogous reason (downstream format constraints).
//!
//! **No filesystem, no streaming** — unlike `id.rs`'s `FallbackIdHasher`
//! (whose streaming create/update/finalize shape exists because hashing can
//! process a `File.slice()` chunk at a time without ever buffering the
//! whole file), extraction fundamentally needs the RAW's full bytes in one
//! contiguous slice (`rawler::rawsource::RawSource::new_from_slice`) — the
//! same requirement `render_bytes`/`decode_bytes` already have, and
//! raw-ffi's own native equivalent reads the whole file with one
//! `std::fs::read` rather than streaming it. The caller already holds the
//! full RAW bytes in memory before it can do anything else with the file
//! (`LibraryCache.bytesForAsset`), so there is no peak-memory win from
//! streaming here — this is a judgment call to keep the binding a plain
//! bytes-in/bytes-out function rather than porting the streaming idiom
//! where it wouldn't reduce allocation.

use wasm_bindgen::prelude::*;

/// Result of [`extract_embedded_preview`]: the extracted preview's final
/// (post-resize, post-orientation-bake) dimensions plus its JPEG bytes.
#[wasm_bindgen]
pub struct EmbeddedPreview {
    width: u32,
    height: u32,
    jpeg: Vec<u8>,
}

#[wasm_bindgen]
impl EmbeddedPreview {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    /// Consume the JPEG buffer WITHOUT cloning: moves the bytes out to JS
    /// and leaves an empty buffer behind. Mirrors `MapleRender::take_rgb`'s
    /// contract in `lib.rs` — the scalar getters (`width`/`height`) stay
    /// valid after the take; a subsequent `take_jpeg` returns an empty
    /// array.
    pub fn take_jpeg(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.jpeg)
    }
}

/// Extract `raw`'s embedded RAW preview/thumbnail, downsample to
/// `max_long_edge` px on the long edge (never upscales), bake in EXIF
/// orientation, and JPEG-encode. Browser-safe: takes bytes already read by
/// the caller (no filesystem access) and returns bytes (no file write).
///
/// `ext` is a lowercase file extension (`"dng"`, `"cr2"`, `"arw"`, …) — same
/// format-hint contract as [`raw_core::decode::decode_bytes`] /
/// `render_bytes`.
///
/// `quality` is JPEG quality in `[1, 100]`; `0` selects the same default
/// (85) as raw-ffi's `maple_render_thumbnail_preview_jpeg_to_file`, so a
/// caller that never overrides quality gets the same encode the server/Apple
/// preview tier uses.
///
/// Errors (thrown as `JsError`): `max_long_edge == 0`, `quality > 100`, or
/// extraction failure (`raw_core::Error::Preview` — no embedded preview in
/// this RAW, unrecognized format, or a caught rawler panic on malformed
/// input).
#[wasm_bindgen]
pub fn extract_embedded_preview(
    raw: &[u8],
    ext: &str,
    max_long_edge: u32,
    quality: u8,
) -> Result<EmbeddedPreview, JsError> {
    const DEFAULT_QUALITY: u8 = 85;

    if max_long_edge == 0 {
        return Err(JsError::new(
            "extract_embedded_preview: max_long_edge must be > 0",
        ));
    }
    if quality > 100 {
        return Err(JsError::new(&format!(
            "extract_embedded_preview: quality must be in [1, 100] (got {})",
            quality
        )));
    }
    let q = if quality == 0 {
        DEFAULT_QUALITY
    } else {
        quality
    };

    let (img, orientation) = raw_core::preview::extract_embedded_preview(raw, ext)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let resized = raw_core::preview::resize_long_edge(img, max_long_edge);
    let rgb_img = resized.to_rgb8();
    let (w, h) = rgb_img.dimensions();
    let (ow, oh, oriented) =
        raw_core::image::apply_orientation(rgb_img.as_raw(), w, h, orientation);
    let jpeg =
        raw_core::jpeg::encode(ow, oh, &oriented, q).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(EmbeddedPreview {
        width: ow,
        height: oh,
        jpeg,
    })
}

// Native-target tests. `EmbeddedPreview`'s plain-Rust getters/`take_jpeg`
// exercise fine off wasm32, but `JsError` itself does NOT (its constructor
// calls into a wasm-bindgen-imported JS `Error`, which panics off an actual
// wasm/JS runtime, and `JsError` implements neither `Debug` nor `Display` —
// there is no way to inspect one on the host target at all). So unlike
// `thumbnail_tests.rs`'s native-FFI error-path coverage (rc codes are plain
// integers, trivially assertable), this binding's four `Err` branches
// (`max_long_edge == 0`, `quality > 100`, and the two ways
// `raw_core::preview::extract_embedded_preview` can fail) are not exercised
// here — same gap `id.rs`'s module doc documents for `FallbackIdHasher`'s
// `JsError`-returning paths, deferred to whichever future task first drives
// this from a real browser/`wasm-bindgen-test` context. The success path
// and its parity guarantee against `raw_core::preview` directly (the actual
// point of this binding) are fully covered below.
#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_path() -> Option<std::path::PathBuf> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../test-fixtures/raws/test_0002.dng");
        if path.exists() {
            Some(path)
        } else {
            eprintln!("fixture missing at {:?} — skipping", path);
            None
        }
    }

    #[test]
    fn fixture_round_trip_caps_long_edge_and_produces_real_jpeg() {
        let Some(path) = fixture_path() else { return };
        let bytes = std::fs::read(&path).expect("read fixture");
        let max_long_edge = 512u32;
        let mut result =
            extract_embedded_preview(&bytes, "dng", max_long_edge, 0).expect("extraction ok");
        assert!(result.width() > 0 && result.height() > 0);
        assert!(
            result.width().max(result.height()) <= max_long_edge,
            "long edge {} exceeds cap {}",
            result.width().max(result.height()),
            max_long_edge
        );
        let jpeg = result.take_jpeg();
        assert_eq!(&jpeg[0..2], &[0xff, 0xd8], "missing JPEG SOI marker");
        // `take_jpeg` leaves the buffer empty — a second call must not
        // return the same bytes again (mirrors `MapleRender::take_rgb`'s
        // contract in `lib.rs`).
        assert!(result.take_jpeg().is_empty());
    }

    /// Byte-identity with the shared core: both this binding and raw-ffi's
    /// native externs call the same `raw_core::preview` functions and the
    /// same `raw_core::jpeg::encode`, so a WASM extraction and a direct
    /// `raw_core` extraction of the same bytes at the same size/quality
    /// must produce byte-identical JPEGs. This is the core parity guarantee
    /// #2010 exists for — web's "unedited" pixels must genuinely match
    /// Apple/server, not just be "close."
    #[test]
    fn matches_raw_core_preview_directly() {
        let Some(path) = fixture_path() else { return };
        let bytes = std::fs::read(&path).expect("read fixture");
        let mut via_wasm = extract_embedded_preview(&bytes, "dng", 512, 85).expect("wasm ok");
        let wasm_w = via_wasm.width();
        let wasm_h = via_wasm.height();
        let wasm_jpeg = via_wasm.take_jpeg();

        let (img, orientation) =
            raw_core::preview::extract_embedded_preview(&bytes, "dng").expect("core ok");
        let resized = raw_core::preview::resize_long_edge(img, 512);
        let rgb_img = resized.to_rgb8();
        let (w, h) = rgb_img.dimensions();
        let (ow, oh, oriented) =
            raw_core::image::apply_orientation(rgb_img.as_raw(), w, h, orientation);
        let core_jpeg = raw_core::jpeg::encode(ow, oh, &oriented, 85).expect("encode ok");

        assert_eq!((wasm_w, wasm_h), (ow, oh));
        assert_eq!(
            wasm_jpeg, core_jpeg,
            "WASM binding must match raw_core::preview byte-for-byte"
        );
    }
}
