//! I/O helpers for the stitch pipeline: frame interleaving for the ALIKED
//! detector and 16-bit PNG quantization.

use crate::ingest::PlanarImage;

/// Develop the scene-linear Rec.2020 composite into a DISPLAY-ENCODED sRGB
/// 16-bit packed-RGB buffer (row-major, R/G/B interleaved) — ready to hand
/// straight to `write_frame_png` as a finished, color-managed panorama (#1335).
///
/// The stitched composite lives in the working space — scene-linear Rec.2020.
/// Written raw (the old `srgb=false` path) it re-opened cold, desaturated and
/// flat: a non-RAW image is assumed display-encoded sRGB, so scene-linear
/// Rec.2020 data was mis-read on every axis (linear-as-gamma, Rec.2020-as-sRGB
/// primaries, no view transform).
///
/// This applies the SAME view tail raw-core uses to develop a RAW
/// (`pipeline/render`): **AgX** at neutral contrast (a stitched pano has no
/// embedded camera JPEG, so there is no Auto Profile to fit — AgX/Neutral is
/// the correct fallback), then **Rec.2020 → sRGB** primaries, then the **sRGB
/// OETF**, then quantizes to 16-bit. The result reads correctly in Maple and in
/// any viewer that assumes sRGB, consistent with how Maple develops RAWs.
///
/// Returns the packed 16-bit buffer directly rather than a `PlanarImage`: the
/// output is display-encoded sRGB, which would violate `PlanarImage`'s
/// scene-linear-Rec.2020 invariant, and quantizing straight from the
/// interleaved buffer avoids re-planarizing a second full-frame copy (peak RSS
/// matters on the 100MP+ pano, notably on iPad via the Apple FFI). The single
/// interleaved `raw_core::Image` copy is required by raw-core's view-tail API,
/// which operates on interleaved `[f32; 3]`.
/// First 8 bytes of `SHA256(name)` as lowercase hex — the pano-injection
/// pre-seed cache key for BOTH `write_display_sidecars` derivatives, single-
/// sourced by contract with Apple's SYNCHRONOUS, hash-of-filename-only path
/// resolver (`MapleSidecarPaths.thumbURL`/`previewURL`, which mirror this
/// function exactly). This resolver is called from UI code that needs a
/// display URL immediately — it cannot afford to read and hash the pano's
/// actual file bytes, so this stays a cheap filename hash rather than a
/// `maple_id` (which every other, INDEXED thumb/preview now uses — see
/// `cachePathForAsset`'s doc in `src/api/src/fs/xmp.ts`). The real,
/// properly-keyed derivatives still get written once the pano is indexed
/// through the standard pipeline; this pre-seed is a short-lived,
/// best-effort stand-in for the gap before that happens — `cache-gc.ts`'s
/// orphan sweep has a matching carve-out so it doesn't delete this scheme
/// out from under a freshly-stitched pano (#1365 follow-up). The Rust copy
/// is guarded by `sha256_prefix16_matches_frozen_cross_platform_value`.
pub(crate) fn sha256_prefix16(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(name.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn develop_for_display(img: &PlanarImage) -> Vec<u16> {
    let n = img.pixel_count();

    // Interleave the planar scene-linear data into a raw_core::Image (the view
    // tail operates on interleaved [f32; 3]). NO clamp: AgX is a scene-referred
    // tone map and needs the extended highlight range (clamping to [0,1] first
    // would blow out highlights the curve should roll).
    let mut scene = raw_core::Image::new(
        img.width(),
        img.height(),
        raw_core::ColorSpace::SceneLinearRec2020,
    );
    for (px, i) in scene.pixels.iter_mut().zip(0..n) {
        *px = [img.r[i], img.g[i], img.b[i]];
    }

    // View tail, in raw-core's RAW-render order.
    raw_core::view::agx::apply(&mut scene, 0.0);
    raw_core::view::encode::rec2020_to_srgb(&mut scene);
    raw_core::view::encode::srgb_gamma_encode(&mut scene);

    // Quantize directly from the interleaved buffer (the sRGB OETF is already
    // applied; clamp guards any out-of-[0,1] residue from the gamut map).
    let mut data = Vec::with_capacity(n * 3);
    for px in &scene.pixels {
        for &v in &px[..3] {
            data.push((v.clamp(0.0, 1.0) * 65535.0).round() as u16);
        }
    }
    data
}

/// Interleave a planar image into the ALIKED detector's packed-RGB f32 layout.
pub fn interleave_planar(img: &PlanarImage) -> Vec<f32> {
    let n = img.pixel_count();
    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n {
        out.push(img.r[i]);
        out.push(img.g[i]);
        out.push(img.b[i]);
    }
    out
}

/// Quantize the scene-linear composite to a 16-bit packed RGB buffer
/// (row-major, R/G/B interleaved). Values are clamped to [0, 1].
/// Optionally applies IEC 61966 sRGB transfer for an eyeball-able preview.
pub fn quantize_to_u16(img: &PlanarImage, srgb: bool) -> Vec<u16> {
    let n = img.pixel_count();
    let mut data = Vec::with_capacity(n * 3);
    for i in 0..n {
        for plane in [&img.r, &img.g, &img.b] {
            let v = plane[i].clamp(0.0, 1.0);
            let v = if srgb { srgb_encode(v) } else { v };
            data.push((v * 65535.0).round() as u16);
        }
    }
    data
}

fn srgb_encode(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        12.92 * v
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// Which encoder a `write_display_sidecars` variant uses.
enum SidecarFormat {
    Avif,
    Jpeg,
}

/// Write the pano-injection pre-seed `.maple/thumbs` (AVIF) + `.maple/previews`
/// (JPEG) derivatives for the pano at `png_path`, downscaled from the
/// already-developed sRGB display buffer (interleaved RGB16, as returned by
/// `develop_for_display`). Both tiers are `sha256_prefix16(filename)`-keyed —
/// see that function's doc for why: this pre-seed is read by Apple's
/// SYNCHRONOUS, hash-of-filename-only `MapleSidecarPaths` resolver, called
/// from UI code that needs a display URL immediately and cannot afford to
/// read+hash the pano's actual bytes. The real `maple_id`-keyed thumb and
/// the developed-preview-tier's own encoding
/// (`ThumbnailLoader+DisplayPreview.swift`, 1600px JPEG) still apply once the
/// pano is indexed / the tier next re-renders; this pre-seed exists only to
/// fill the gap before that happens, so it must match whatever Apple's
/// reader is CURRENTLY looking for at the SAME key, not the server's
/// separate, `maple_id`/path-keyed indexed-asset convention
/// (`cachePathForAsset` in `src/api/src/fs/xmp.ts`) — the two are
/// deliberately different schemes for different purposes; see `cache-gc.ts`'s
/// legacy-scheme carve-out for how the server still avoids orphan-sweeping
/// this one (#1365 follow-up).
///
/// Consumes `display` (moved into an `ImageBuffer` — no full-frame clone;
/// peak RSS matters on a 100MP+ pano). Non-fatal to the caller: a stitch has
/// already succeeded by the time this runs, so callers log + ignore `Err`.
pub fn write_display_sidecars(
    display: Vec<u16>,
    width: u32,
    height: u32,
    png_path: &std::path::Path,
) -> Result<(), String> {
    use image::{imageops::FilterType, DynamicImage, ImageBuffer, Rgb};

    let basename = png_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("bad pano path: {png_path:?}"))?;
    let key = sha256_prefix16(basename);

    let src = ImageBuffer::<Rgb<u16>, _>::from_raw(width, height, display)
        .ok_or_else(|| "display buffer length != width*height*3".to_string())?;

    // (subdir, filename, target long edge, format, quality)
    let variants = [
        ("thumbs", format!("{key}.avif"), 256u32, SidecarFormat::Avif, 55u8),
        ("previews", format!("{key}_1600.jpg"), 1600u32, SidecarFormat::Jpeg, 85u8),
    ];

    for (subdir, filename, target, format, quality) in variants {
        let (tw, th) = fit_long_edge(width, height, target);
        let resized: ImageBuffer<Rgb<u16>, Vec<u16>> = if (tw, th) == (width, height) {
            src.clone() // only when the pano is already ≤ target (tiny) — cheap
        } else {
            image::imageops::resize(&src, tw, th, FilterType::Triangle)
        };
        let rgb8 = DynamicImage::ImageRgb16(resized).into_rgb8().into_raw();
        let encoded = match format {
            SidecarFormat::Avif => raw_core::avif::encode(tw, th, &rgb8, quality),
            SidecarFormat::Jpeg => raw_core::jpeg::encode(tw, th, &rgb8, quality),
        }
        .map_err(|e| e.to_string())?;

        let dir = png_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join(".maple")
            .join(subdir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(filename), encoded).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Fit `(width, height)` to a max long edge, preserving aspect, never upscaling.
fn fit_long_edge(width: u32, height: u32, target: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= target {
        return (width, height);
    }
    let scale = target as f64 / long as f64;
    let w = ((width as f64 * scale).round() as u32).max(1);
    let h = ((height as f64 * scale).round() as u32).max(1);
    (w, h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::ValidityMask;

    /// Read the encoded width/height straight out of an AVIF file's `ispe`
    /// box, without a full AV1 decode — this crate only enables the `image`
    /// crate's `avif` (encode) feature, deliberately not `avif-native`
    /// (decode, which pulls in `dav1d` via a C toolchain build). Mirrors
    /// `raw-ffi`'s `thumbnail_tests::avif_dimensions` test helper.
    fn avif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
        fn find_box(data: &[u8], want: &[u8; 4]) -> Option<(usize, usize)> {
            let mut i = 0;
            while i + 8 <= data.len() {
                let size = u32::from_be_bytes(data[i..i + 4].try_into().ok()?) as usize;
                let kind = &data[i + 4..i + 8];
                if size < 8 || i + size > data.len() {
                    return None;
                }
                if kind == want {
                    return Some((i + 8, size - 8));
                }
                i += size;
            }
            None
        }

        let (meta_start, meta_len) = find_box(bytes, b"meta")?;
        let meta_body = bytes.get(meta_start + 4..meta_start + meta_len)?;
        let (iprp_start, iprp_len) = find_box(meta_body, b"iprp")?;
        let iprp_body = meta_body.get(iprp_start..iprp_start + iprp_len)?;
        let (ipco_start, ipco_len) = find_box(iprp_body, b"ipco")?;
        let ipco_body = iprp_body.get(ipco_start..ipco_start + ipco_len)?;
        let (ispe_start, _) = find_box(ipco_body, b"ispe")?;
        let w = u32::from_be_bytes(ipco_body.get(ispe_start + 4..ispe_start + 8)?.try_into().ok()?);
        let h = u32::from_be_bytes(ipco_body.get(ispe_start + 8..ispe_start + 12)?.try_into().ok()?);
        Some((w, h))
    }

    #[test]
    fn sha256_prefix16_matches_frozen_cross_platform_value() {
        // MUST equal Apple's MapleThumbCacheKey.sha256Prefix16 and the API's
        // sha256Prefix16 for the same input — the .maple/ pre-seed cache key
        // contract.
        assert_eq!(sha256_prefix16("panorama-test.png"), "88bab9b0d022c93c");
    }

    #[test]
    fn write_display_sidecars_writes_canonical_thumb_and_preview() {
        use image::GenericImageView;
        // 400x200 scene-linear mid-grey pano: thumb downsizes (long edge 256),
        // preview stays native (400 < 1600 → no upscale).
        let (w, h) = (400u32, 200u32);
        let n = (w * h) as usize;
        let pano = PlanarImage::from_planes(
            w,
            h,
            vec![0.18_f32; n],
            vec![0.18_f32; n],
            vec![0.18_f32; n],
            ValidityMask::new_filled(w, h, true),
        );
        let display = develop_for_display(&pano);

        // PID + per-process atomic counter so concurrent / repeated test runs
        // can't collide on the temp dir (matches render.rs::unique_tmp_png).
        let dir = {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            std::env::temp_dir().join(format!(
                "maple_pano_sidecar_test_{pid}_{n}",
                pid = std::process::id()
            ))
        };
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let png_path = dir.join("panorama-test.png");

        write_display_sidecars(display, w, h, &png_path).unwrap();

        let key = sha256_prefix16("panorama-test.png");
        let thumb = dir.join(".maple/thumbs").join(format!("{key}.avif"));
        let preview = dir.join(".maple/previews").join(format!("{key}_1600.jpg"));
        assert!(thumb.exists(), "thumb missing: {thumb:?}");
        assert!(preview.exists(), "preview missing: {preview:?}");

        let thumb_bytes = std::fs::read(&thumb).unwrap();
        assert_eq!(&thumb_bytes[4..8], b"ftyp", "missing AVIF ftyp box");
        let (tw, th) = avif_dimensions(&thumb_bytes).expect("ispe box present");
        assert_eq!(tw.max(th), 256, "thumb long edge");

        let p = image::open(&preview).unwrap();
        assert_eq!(p.dimensions(), (400, 200), "preview must not upscale");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `develop_for_display` must tone-map (AgX) and display-encode (sRGB) the
    /// scene-linear composite — not pass it through. Three grey scene-linear
    /// pixels (shadow / mid / blown highlight) must come back display-encoded,
    /// monotonic, in-gamut, and visibly shifted from a naive sRGB encode (i.e.
    /// AgX actually ran).
    #[test]
    fn develop_for_display_tone_maps_and_encodes() {
        let (w, h) = (3u32, 1u32);
        let planes = vec![0.02_f32, 0.18, 4.0]; // shadow, mid-grey, HDR highlight
        let pano = PlanarImage::from_planes(
            w,
            h,
            planes.clone(),
            planes.clone(),
            planes.clone(),
            ValidityMask::new_filled(w, h, true),
        );

        // Packed 16-bit RGB: 3 pixels × 3 channels.
        let data = develop_for_display(&pano);
        assert_eq!(data.len(), 9);
        // pixel `p`, channel `c` → data[p*3 + c], normalised to [0, 1].
        let v = |p: usize, c: usize| data[p * 3 + c] as f32 / 65535.0;
        let (shadow, mid, high) = (v(0, 0), v(1, 0), v(2, 0));

        // Monotonic tone response: shadow < mid < highlight.
        assert!(
            shadow < mid && mid < high,
            "non-monotonic: {shadow} {mid} {high}"
        );
        // Grey in → grey out (gamut convert + AgX preserve neutrals).
        for p in 0..3 {
            assert!(
                (v(p, 0) - v(p, 1)).abs() < 1e-3,
                "neutral drift at pixel {p}"
            );
            assert!(
                (v(p, 0) - v(p, 2)).abs() < 1e-3,
                "neutral drift at pixel {p}"
            );
        }
        // AgX anchors mid-grey ~0.18 by design, so it ≈ a plain sRGB encode —
        // NOT where AgX shows. AgX shows on the HDR highlight: the +4.5-stop 4.0
        // input is ROLLED below clip-white by the AgX shoulder, whereas the OLD
        // path (clip to 1.0 → sRGB) returned exactly 1.0 for any input ≥ 1.0.
        assert!(
            high < 0.99,
            "HDR highlight should roll below clip-white via AgX, got {high}"
        );
        // Sanity: mid-grey lands in the expected AgX-anchored band (~0.46).
        assert!(
            (0.40..=0.52).contains(&mid),
            "mid-grey off AgX anchor: {mid}"
        );
    }
}
