use super::*;

fn ramp(w: u32, h: u32) -> RasterImage {
    RasterImage::new_rgb(
        w,
        h,
        (0..(w as usize * h as usize * 3))
            .map(|i| (i % 251) as u8)
            .collect(),
    )
}

fn opts() -> TiffOptions {
    TiffOptions {
        compression: TiffCompression::Lzw,
        bitdepth: 8,
        predictor: true,
    }
}

fn is_tiff(bytes: &[u8]) -> bool {
    &bytes[..4] == b"II*\0" || &bytes[..4] == b"MM\0*"
}

#[test]
fn encodes_an_eight_bit_tiff_that_round_trips() {
    let src = ramp(16, 16);
    let bytes = encode_tiff_opts(&src, &opts(), None).unwrap();
    assert!(is_tiff(&bytes));
    let decoded = crate::raster::decode_raster(&bytes, Some("tiff")).unwrap();
    assert_eq!(decoded.data, src.data, "LZW TIFF must be lossless");
}

#[test]
fn sixteen_bit_widens_the_samples() {
    let src = ramp(16, 16);
    let bytes = encode_tiff_opts(
        &src,
        &TiffOptions {
            bitdepth: 16,
            compression: TiffCompression::None,
            ..opts()
        },
        None,
    )
    .unwrap();
    // 16x16 RGB16 is 1536 bytes of pixel data alone.
    assert!(
        bytes.len() > 1536,
        "too small to hold 16-bit samples: {}",
        bytes.len()
    );
    let decoded = crate::raster::decode_raster(&bytes, Some("tiff")).unwrap();
    assert_eq!((decoded.width, decoded.height), (16, 16));
}

/// A solid-colour raster: nothing but horizontal runs, which is the input
/// PackBits (a pure run-length coder) is for. The `ramp` source below has no
/// runs at all once the horizontal predictor is off, so PackBits *expands*
/// it — that is the codec working as designed, not a defect, and libvips
/// behaves the same way (measured: `sharp().tiff({compression:'packbits'})`
/// on a noise source is larger than its uncompressed output too).
fn runs(w: u32, h: u32) -> RasterImage {
    RasterImage::new_rgb(w, h, vec![40u8; (w * h * 3) as usize])
}

#[test]
fn compression_actually_shrinks_the_file() {
    let uncompressed = |src: &RasterImage| {
        encode_tiff_opts(
            src,
            &TiffOptions {
                compression: TiffCompression::None,
                ..opts()
            },
            None,
        )
        .unwrap()
        .len()
    };
    // LZW and Deflate are the two compressors that keep the horizontal
    // predictor (see `the_horizontal_predictor_is_written_only_for_lzw_and_deflate`)
    // and both are dictionary coders, so a gradient is enough. PackBits
    // gets a run-heavy source instead — it is run-length only, and with no
    // predictor to flatten the gradient into runs it would grow the ramp.
    let cases = [
        (TiffCompression::Lzw, ramp(64, 64)),
        (TiffCompression::Deflate, ramp(64, 64)),
        (TiffCompression::Packbits, runs(64, 64)),
    ];
    for (compression, src) in cases {
        let plain = uncompressed(&src);
        let packed = encode_tiff_opts(
            &src,
            &TiffOptions {
                compression,
                ..opts()
            },
            None,
        )
        .unwrap();
        assert!(
            packed.len() < plain,
            "{compression:?} ({}) did not beat uncompressed ({plain})",
            packed.len(),
        );
    }
}

#[test]
fn the_icc_profile_is_written_as_tag_34675() {
    let icc = crate::icc::profile_for(crate::view::encode::TargetPrimaries::P3);
    let bytes = encode_tiff_opts(&ramp(8, 8), &opts(), Some(&icc)).unwrap();
    // The profile's own 'acsp' signature lives at byte 36 of any ICC blob.
    assert!(
        bytes.windows(4).any(|w| w == b"acsp"),
        "no ICC payload in the TIFF"
    );
}

#[test]
fn an_unsupported_channel_count_is_rejected() {
    // Neither grayscale (1) nor gray+alpha (2) are wired up — only RGB
    // (3) and RGBA (4) are.
    let gray = RasterImage {
        width: 2,
        height: 2,
        channels: 1,
        data: vec![0; 4],
        orientation: crate::image::ExifOrientation::Normal,
    };
    assert!(encode_tiff_opts(&gray, &opts(), None).is_err());
}

/// RGBA input: an interleaved `[R, G, B, A, ...]` buffer with a
/// distinct, non-zero value per color channel and a transparent (0)
/// alpha, so a channel swap or a corrupted 4th sample would be caught.
fn rgba_ramp(w: u32, h: u32) -> RasterImage {
    let mut data = Vec::with_capacity((w * h * 4) as usize);
    for i in 0..(w * h) {
        let base = (i % 60) as u8;
        data.push(base + 1); // R
        data.push(base + 2); // G
        data.push(base + 3); // B
        data.push(0); // straight alpha: fully transparent
    }
    RasterImage::new_rgba(w, h, data)
}

#[test]
fn rgba_eight_bit_round_trips_with_extra_samples_tag() {
    let src = rgba_ramp(8, 8);
    let bytes = encode_tiff_opts(&src, &opts(), None).unwrap();

    let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
    assert_eq!(
        decoder.colortype().unwrap(),
        tiff::ColorType::RGBA(8),
        "the decoder must recognize the extra sample as alpha"
    );
    let extra_samples = decoder.get_tag_u16_vec(Tag::ExtraSamples).unwrap();
    assert_eq!(
        extra_samples,
        vec![2],
        "tag 338 must declare unassociated (straight) alpha"
    );
    match decoder.read_image().unwrap() {
        tiff::decoder::DecodingResult::U8(decoded) => {
            assert_eq!(decoded, src.data, "RGBA8 must round-trip losslessly");
            assert!(
                decoded.iter().skip(3).step_by(4).all(|&a| a == 0),
                "every alpha byte must survive as 0"
            );
        }
        other => panic!("expected an 8-bit decode result, got {other:?}"),
    }
}

#[test]
fn rgba_sixteen_bit_round_trips_with_extra_samples_tag() {
    let src = rgba_ramp(8, 8);
    let bytes = encode_tiff_opts(
        &src,
        &TiffOptions {
            bitdepth: 16,
            compression: TiffCompression::Lzw,
            ..opts()
        },
        None,
    )
    .unwrap();

    let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
    assert_eq!(decoder.colortype().unwrap(), tiff::ColorType::RGBA(16));
    let extra_samples = decoder.get_tag_u16_vec(Tag::ExtraSamples).unwrap();
    assert_eq!(extra_samples, vec![2]);
    match decoder.read_image().unwrap() {
        tiff::decoder::DecodingResult::U16(decoded) => {
            assert_eq!(decoded.len(), src.data.len(), "same sample count, widened");
            assert!(
                decoded.iter().skip(3).step_by(4).all(|&a| a == 0),
                "the widened alpha sample must still be 0"
            );
            // A widened non-zero channel byte must not collapse to 0.
            assert!(decoded[0] > 0, "widened red sample must stay non-zero");
        }
        other => panic!("expected a 16-bit decode result, got {other:?}"),
    }
}

#[test]
fn an_unsupported_bit_depth_is_rejected() {
    assert!(encode_tiff_opts(
        &ramp(4, 4),
        &TiffOptions {
            bitdepth: 12,
            ..opts()
        },
        None
    )
    .is_err());
}

/// Tag 259 (`Compression`) must name the actual algorithm chosen, not
/// just shrink the file (`compression_actually_shrinks_the_file` above
/// only checks size). TIFF's own numeric codes: None=1, LZW=5,
/// Deflate(Adobe)=8, PackBits=0x8005.
#[test]
fn tag_259_names_the_chosen_compression() {
    let cases = [
        (TiffCompression::None, 1u16),
        (TiffCompression::Lzw, 5),
        (TiffCompression::Deflate, 8),
        (TiffCompression::Packbits, 0x8005),
    ];
    for (compression, expected) in cases {
        let bytes = encode_tiff_opts(
            &ramp(4, 4),
            &TiffOptions {
                compression,
                ..opts()
            },
            None,
        )
        .unwrap();
        let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
        let tag: u16 = decoder.get_tag_unsigned(Tag::Compression).unwrap();
        assert_eq!(tag, expected, "{compression:?} wrote the wrong tag 259");
    }
}

/// Tag 317 (`Predictor`) must reflect the caller's `predictor` choice on
/// the alpha-free (3-channel) path: 1 (`None`) when `predictor: false`,
/// 2 (`Horizontal`) when `predictor: true` (the default `opts()` used
/// throughout this module already exercises the `true` case implicitly
/// via `encodes_an_eight_bit_tiff_that_round_trips`'s lossless check;
/// this test is the one that actually reads tag 317 back).
#[test]
fn tag_317_reflects_the_predictor_choice() {
    for (predictor, expected_tag) in [(true, 2u16), (false, 1u16)] {
        let bytes = encode_tiff_opts(
            &ramp(8, 8),
            &TiffOptions {
                predictor,
                ..opts()
            },
            None,
        )
        .unwrap();
        let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
        let tag: u16 = decoder.get_tag_unsigned(Tag::Predictor).unwrap();
        assert_eq!(
            tag, expected_tag,
            "predictor: {predictor} wrote the wrong tag 317"
        );
    }
}

/// TIFF 6.0 defines tag 317 only for LZW and Deflate. libtiff ignores it on
/// an uncompressed or PackBits strip and reads the differenced bytes back as
/// pixels, so `predictor: true` must be dropped for those two compressors —
/// which is also what libvips does (measured: `sharp().tiff()` omits 317
/// entirely for `none`/`packbits`). Before this narrowing,
/// `tiff({ compression: 'none' })` — an ordinary call, no predictor
/// mention — handed back a file that decoded to garbage everywhere but in
/// the crate that wrote it.
///
/// The cross-decoder half of this gate (libtiff, via sharp) lives in
/// `src/maple/test/oracle.test.ts`; the `tiff` crate cannot catch the bug
/// itself because it un-differences whatever the tag claims, so encoder and
/// decoder cancel out.
#[test]
fn the_horizontal_predictor_is_written_only_for_lzw_and_deflate() {
    let cases = [
        (TiffCompression::None, 1u16),
        (TiffCompression::Lzw, 2),
        (TiffCompression::Deflate, 2),
        (TiffCompression::Packbits, 1),
    ];
    for (compression, expected_tag) in cases {
        let src = ramp(16, 16);
        let bytes = encode_tiff_opts(
            &src,
            &TiffOptions {
                compression,
                predictor: true,
                ..opts()
            },
            None,
        )
        .unwrap();
        let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
        let tag: u16 = decoder.get_tag_unsigned(Tag::Predictor).unwrap();
        assert_eq!(
            tag, expected_tag,
            "{compression:?} with predictor: true wrote tag 317 = {tag}"
        );
        let decoded = crate::raster::decode_raster(&bytes, Some("tiff")).unwrap();
        assert_eq!(decoded.data, src.data, "{compression:?} was not lossless");
    }
}

/// `predictor: false` must still encode a correct, losslessly
/// round-tripping file — not merely "a file with tag 317 set to 1".
#[test]
fn predictor_false_still_round_trips_losslessly() {
    let src = ramp(16, 16);
    let bytes = encode_tiff_opts(
        &src,
        &TiffOptions {
            predictor: false,
            ..opts()
        },
        None,
    )
    .unwrap();
    let decoded = crate::raster::decode_raster(&bytes, Some("tiff")).unwrap();
    assert_eq!(decoded.data, src.data);
}

/// The 16-bit path's existing coverage (`sixteen_bit_widens_the_samples`,
/// `rgba_sixteen_bit_round_trips_with_extra_samples_tag`) checks file
/// size and non-zero-ness but never the actual widened *value* — this
/// pins the exact `v * 257` mapping (the only way to widen 8-bit full
/// scale [0,255] to 16-bit full scale [0,65535] without a divide) for
/// every sample, not just the first.
#[test]
fn sixteen_bit_widens_every_sample_by_exactly_257x() {
    let src = ramp(4, 4);
    let bytes = encode_tiff_opts(
        &src,
        &TiffOptions {
            bitdepth: 16,
            compression: TiffCompression::None,
            ..opts()
        },
        None,
    )
    .unwrap();
    let mut decoder = tiff::decoder::Decoder::new(std::io::Cursor::new(&bytes)).unwrap();
    match decoder.read_image().unwrap() {
        tiff::decoder::DecodingResult::U16(decoded) => {
            assert_eq!(decoded.len(), src.data.len());
            for (widened, &original) in decoded.iter().zip(&src.data) {
                assert_eq!(*widened, u16::from(original) * 257);
            }
        }
        other => panic!("expected a 16-bit decode result, got {other:?}"),
    }
}
