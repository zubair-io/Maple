use super::*;

fn gradient_rgb(w: u32, h: u32) -> Vec<u8> {
    (0..h)
        .flat_map(|y| {
            (0..w).flat_map(move |x| {
                let r = (x * 255 / (w - 1)) as u8;
                let g = (y * 255 / (h - 1)) as u8;
                [r, g, 128u8]
            })
        })
        .collect()
}

fn mean_abs_error(a: &[u8], b: &[u8]) -> f64 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(x, y)| (*x as f64 - *y as f64).abs())
        .sum::<f64>()
        / a.len() as f64
}

#[test]
fn round_trips_an_rgb_avif_within_tolerance() {
    let (w, h) = (64, 48);
    let rgb = gradient_rgb(w, h);
    let bytes = crate::avif::encode(w, h, &rgb, 80).unwrap();
    assert!(is_avif(&bytes));
    let decoded = decode_avif(&bytes).unwrap();
    assert_eq!((decoded.width, decoded.height, decoded.channels), (w, h, 3));
    let mae = mean_abs_error(&decoded.data, &rgb);
    assert!(mae < 3.0, "mean abs error {mae} too high for q80 AVIF");
}

#[test]
fn decodes_the_alpha_item_into_rgba() {
    use image::{codecs::avif::AvifEncoder, ExtendedColorType, ImageEncoder};
    let (w, h) = (16u32, 8u32);
    let rgba: Vec<u8> = (0..(w * h))
        .flat_map(|i| [200u8, 100, 50, if i % 2 == 0 { 255 } else { 0 }])
        .collect();
    let mut out = Vec::new();
    AvifEncoder::new_with_speed_quality(&mut out, 8, 90)
        .write_image(&rgba, w, h, ExtendedColorType::Rgba8)
        .unwrap();
    let decoded = decode_avif(&out).unwrap();
    assert_eq!(decoded.channels, 4);
    assert_eq!(decoded.data.len(), (w * h * 4) as usize);
    // Alpha is coded losslessly enough at q90 to keep the checkerboard.
    assert!(decoded.data[3] > 200 && decoded.data[7] < 60);
}

#[test]
fn probe_reads_dimensions_without_decoding_pixels() {
    let rgb = gradient_rgb(40, 30);
    let bytes = crate::avif::encode(40, 30, &rgb, 60).unwrap();
    let probe = probe_avif(&bytes).unwrap();
    assert_eq!(
        (probe.width, probe.height, probe.has_alpha, probe.bit_depth),
        (40, 30, false, 8)
    );
}

#[test]
fn an_empty_obu_is_rejected_before_it_reaches_rav1d() {
    // This guard is load-bearing, not defensive: rav1d's `validate_input!`
    // calls `std::process::abort()` outright in a debug build, so handing
    // either entry point a zero-length payload kills the process with no
    // panic for any barrier to catch. Both call sites are covered here
    // because both rav1d functions reject `sz == 0`.
    let Err(decoded) = decode_obu(&[]) else {
        panic!("an empty OBU must never reach dav1d_send_data");
    };
    let Err(probed) = sequence_header(&[]) else {
        panic!("an empty OBU must never reach dav1d_parse_sequence_header");
    };
    for e in [decoded, probed] {
        assert!(
            e.to_string().contains("avif item carries no AV1 payload"),
            "unexpected error: {e}"
        );
    }
}

#[test]
fn rejects_non_avif_bytes() {
    assert!(!is_avif(b"\x89PNG\r\n\x1a\n"));
    assert!(decode_avif(b"not an avif at all").is_err());
}

#[test]
fn frame_size_limit_rejects_frames_larger_than_the_ceiling() {
    let rgb = gradient_rgb(64, 48);
    let bytes = crate::avif::encode(64, 48, &rgb, 60).unwrap();
    let data = parse_container(&bytes).unwrap();
    // Control: the shipped ceiling decodes this 3,072-pixel frame.
    assert!(decode_obu_with_limit(&data.primary_item, AVIF_MAX_FRAME_PIXELS).is_ok());
    // A ceiling below the frame's pixel count fails as a clean `Err`
    // rather than allocating the planes — which is what protects us from
    // an AVIF whose frame header declares an absurd size.
    let Err(e) = decode_obu_with_limit(&data.primary_item, 1024) else {
        panic!("a 1,024-pixel ceiling must reject a 3,072-pixel frame");
    };
    assert!(format!("{e}").contains("dav1d"), "unexpected error: {e}");
}
