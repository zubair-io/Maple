use super::*;

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
    let w = u32::from_be_bytes(
        ipco_body
            .get(ispe_start + 4..ispe_start + 8)?
            .try_into()
            .ok()?,
    );
    let h = u32::from_be_bytes(
        ipco_body
            .get(ispe_start + 8..ispe_start + 12)?
            .try_into()
            .ok()?,
    );
    Some((w, h))
}

/// The pre-#5451 derivative path: resize the full developed image directly.
fn direct(width: u32, height: u32, display: &[u16]) -> Vec<(u32, u32, Vec<u8>)> {
    let src = ImageBuffer::<Rgb<u16>, _>::from_raw(width, height, display.to_vec()).unwrap();
    VARIANTS
        .iter()
        .map(|&(_, target, _)| {
            let (w, h) = fit_long_edge(width, height, target);
            let resized = if (w, h) == (width, height) {
                src.clone()
            } else {
                image::imageops::resize(&src, w, h, FilterType::Triangle)
            };
            (
                w,
                h,
                DynamicImage::ImageRgb16(resized).into_rgb8().into_raw(),
            )
        })
        .collect()
}

fn streamed(width: u32, height: u32, display: &[u16], block_rows: u32) -> Vec<(u32, u32, Vec<u8>)> {
    let mut down = SidecarDownscaler::new(width, height);
    for block in display.chunks(width as usize * 3 * block_rows as usize) {
        down.push_rows(block);
    }
    down.derivatives()
        .unwrap()
        .into_iter()
        .map(|d| (d.width, d.height, d.rgb8))
        .collect()
}

/// Smooth sky-like gradient with fine texture, interleaved RGB16.
fn scene(width: u32, height: u32) -> Vec<u16> {
    (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .flat_map(|(x, y)| {
            let (fx, fy) = (x as f32 / width as f32, y as f32 / height as f32);
            let texture = ((x * 7 + y * 13) % 17) as f32 / 17.0 * 0.05;
            [
                fx * 0.8 + texture,
                fy * 0.6 + 0.2 + texture,
                (1.0 - fx) * 0.5 + texture,
            ]
        })
        .map(|v| (v.clamp(0.0, 1.0) * 65535.0).round() as u16)
        .collect()
}

#[test]
fn pano_within_intermediate_matches_direct_resize_exactly() {
    let (w, h) = (2000, 700);
    let display = scene(w, h);
    assert_eq!(streamed(w, h, &display, 128), direct(w, h, &display));
}

#[test]
fn large_pano_stays_within_one_level_of_direct_resize() {
    let (w, h) = (9000, 2600);
    let display = scene(w, h);
    for ((sw, sh, s), (dw, dh, d)) in streamed(w, h, &display, 128)
        .into_iter()
        .zip(direct(w, h, &display))
    {
        assert_eq!((sw, sh), (dw, dh));
        let diffs: Vec<i32> = s
            .iter()
            .zip(&d)
            .map(|(&a, &b)| (i32::from(a) - i32::from(b)).abs())
            .collect();
        let mean = diffs.iter().sum::<i32>() as f64 / diffs.len() as f64;
        let max = *diffs.iter().max().unwrap();
        assert!(mean <= 0.5 && max <= 3, "{sw}x{sh}: mean {mean} max {max}");
    }
}

#[test]
fn derivatives_refuse_a_partial_image() {
    let mut down = SidecarDownscaler::new(10, 4);
    down.push_rows(&[0u16; 10 * 3 * 3]);
    assert!(down.derivatives().is_err());
}

#[test]
fn write_puts_canonical_thumb_and_preview_beside_the_pano() {
    let (w, h) = (800u32, 400u32);
    let dir = {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "maple_pano_sidecar_test_{}_{n}",
            std::process::id()
        ))
    };
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let png_path = dir.join("panorama-test.png");

    let mut down = SidecarDownscaler::new(w, h);
    down.push_rows(&scene(w, h));
    down.write(&png_path).unwrap();

    // #2009 — preview is the canonical `<filename>.avif`, so Apple's read
    // path finds it.
    let thumb = std::fs::read(dir.join(".maple/thumbs/panorama-test.png.avif")).unwrap();
    let preview = std::fs::read(dir.join(".maple/previews/panorama-test.png.avif")).unwrap();
    assert_eq!(&thumb[4..8], b"ftyp", "missing AVIF ftyp box");
    assert_eq!(
        avif_dimensions(&thumb).map(|(a, b)| a.max(b)),
        Some(512),
        "thumb long edge"
    );
    assert_eq!(
        avif_dimensions(&preview),
        Some((800, 400)),
        "preview must not upscale"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
