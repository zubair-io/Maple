use super::*;

fn bx(kind: &[u8; 4], payload: &[u8], wide: bool) -> Vec<u8> {
    let mut bytes = if wide {
        [
            1u32.to_be_bytes().as_slice(),
            kind,
            &((payload.len() + 16) as u64).to_be_bytes(),
        ]
        .concat()
    } else {
        [((payload.len() + 8) as u32).to_be_bytes().as_slice(), kind].concat()
    };
    bytes.extend_from_slice(payload);
    bytes
}

fn boxes(bytes: &[u8]) -> Vec<(&[u8], &[u8])> {
    let mut at = 0;
    let mut out = Vec::new();
    while at < bytes.len() {
        let size = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        out.push((&bytes[at + 4..at + 8], &bytes[at..at + size]));
        at += size;
    }
    out
}

/// Re-mux a real encoded AV1 item with iloc v0/v1/v2 and disjoint extents.
/// One byte in the first extent makes even the first OBU straddle extents.
fn remux(item: &[u8], version: u8, wide: bool) -> Vec<u8> {
    let rgb = vec![120u8; 8 * 6 * 3];
    let base = crate::avif::encode_with_speed(8, 6, &rgb, 50, 10).unwrap();
    let top = boxes(&base);
    let ftyp = top.iter().find(|(kind, _)| *kind == b"ftyp").unwrap().1;
    let meta = top.iter().find(|(kind, _)| *kind == b"meta").unwrap().1;
    let children = boxes(&meta[12..]);
    let make_iloc = |first: u32, second: u32| {
        let mut payload = vec![version, 0, 0, 0, 0x44, 0];
        if version == 2 {
            payload.extend_from_slice(&1u32.to_be_bytes());
        } else {
            payload.extend_from_slice(&1u16.to_be_bytes());
        }
        if version == 2 {
            payload.extend_from_slice(&1u32.to_be_bytes());
        } else {
            payload.extend_from_slice(&1u16.to_be_bytes());
        }
        if version > 0 {
            payload.extend_from_slice(&[0, 0]);
        } // construction method
        payload.extend_from_slice(&[0, 0]); // data reference
        payload.extend_from_slice(&2u16.to_be_bytes());
        payload.extend_from_slice(&first.to_be_bytes());
        payload.extend_from_slice(&1u32.to_be_bytes());
        payload.extend_from_slice(&second.to_be_bytes());
        payload.extend_from_slice(&((item.len() - 1) as u32).to_be_bytes());
        bx(b"iloc", &payload, false)
    };
    let make_meta = |iloc: Vec<u8>| {
        let payload: Vec<u8> = children
            .iter()
            .flat_map(|(kind, bytes)| {
                if *kind == b"iloc" {
                    iloc.clone()
                } else {
                    bytes.to_vec()
                }
            })
            .collect();
        bx(b"meta", &[vec![0; 4], payload].concat(), false)
    };
    let provisional = make_meta(make_iloc(0, 0));
    let header = if wide { 16 } else { 8 };
    let first = (ftyp.len() + provisional.len() + header) as u32;
    let mdat1 = bx(b"mdat", &item[..1], wide);
    let free = bx(b"free", &[0; 33], false);
    let second = (ftyp.len() + provisional.len() + mdat1.len() + free.len() + header) as u32;
    let meta = make_meta(make_iloc(first, second));
    [
        ftyp.to_vec(),
        meta,
        mdat1,
        free,
        bx(b"mdat", &item[1..], wide),
    ]
    .concat()
}

fn encoded_item() -> Vec<u8> {
    let base = crate::avif::encode_with_speed(8, 6, &vec![100u8; 8 * 6 * 3], 50, 10).unwrap();
    avif_parse::read_avif(&mut Cursor::new(base))
        .unwrap()
        .primary_item
        .to_vec()
}

#[test]
fn metadata_reader_avif_handles_iloc_versions_multiple_extents_and_wide_boxes() {
    let item = encoded_item();
    for version in 0..=2 {
        for wide in [false, true] {
            let bytes = remux(&item, version, wide);
            assert_eq!(probe_raster_metadata(&bytes).unwrap().width, 8);
            assert_parity(&bytes, &format!("iloc{version} wide{wide}"));
        }
    }
}

#[test]
fn metadata_reader_avif_skips_large_obus_and_still_validates_following_headers() {
    let item = encoded_item();
    // An AV1 padding OBU, then the real sequence and frame OBUs.
    let mut padded = vec![0x7a, 0x80, 0x80, 0x80, 0x01]; // type 15, length 2 MiB
    padded.resize(padded.len() + 2 * 1024 * 1024, 0);
    padded.extend_from_slice(&item);
    let bytes = remux(&padded, 2, true);
    let file = TestFile::new(&bytes);
    let mut reader = BufReader::new(Counted::new(file.open()));
    assert_eq!(
        analyze_reader(&mut reader, METADATA).unwrap(),
        analyze(&bytes, METADATA).unwrap()
    );
    assert!(
        reader.get_ref().bytes_read < 128 * 1024,
        "read {}",
        reader.get_ref().bytes_read
    );
    for suffix in [
        &[0x0a][..],
        &[0x0a, 0xff],
        &[0x0e, 0],
        &[0x7a, 0xff, 0xff, 0xff, 0xff, 0x7f],
    ] {
        let bytes = remux(&[item.as_slice(), suffix].concat(), 1, false);
        assert!(probe_raster_metadata(&bytes).is_err());
        assert_parity(&bytes, "malformed OBU after valid sequence");
    }
}

#[test]
fn metadata_reader_avif_uses_av1_dimensions_and_preserves_orientation() {
    let mut bytes = fixtures()
        .into_iter()
        .find(|(name, _)| *name == "avif")
        .unwrap()
        .1;
    let ispe = bytes.windows(4).position(|w| w == b"ispe").unwrap();
    bytes[ispe + 8..ispe + 12].copy_from_slice(&123u32.to_be_bytes());
    bytes[ispe + 12..ispe + 16].copy_from_slice(&456u32.to_be_bytes());
    let probe = probe_raster_metadata(&bytes).unwrap();
    assert_eq!((probe.width, probe.height), (6, 8)); // irot applies, EXIF stays advisory
    assert_eq!(probe.orientation, None);
    assert!(!probe.has_alpha);
    assert_parity(&bytes, "ispe differs from AV1 header");
}

#[test]
fn metadata_reader_avif_preserves_real_alpha_and_all_container_transforms() {
    let pixels = RasterImage::new_rgba(8, 6, (0..48).flat_map(|i| [100, 200, 50, i * 5]).collect());
    let options = crate::raster_encode_avif::AvifOptions {
        effort: 0,
        ..Default::default()
    };
    let alpha = crate::raster_recipe_encode::encode_raster_output(
        &pixels,
        &RasterOutput::Avif(options),
        &Default::default(),
        crate::view::encode::TargetPrimaries::Srgb,
    )
    .unwrap();
    assert!(
        probe_raster_metadata_reader(&mut Cursor::new(&alpha))
            .unwrap()
            .has_alpha
    );
    assert_parity(&alpha, "AVIF with real alpha item");
    let base = crate::avif::encode_with_speed(8, 6, &vec![100u8; 8 * 6 * 3], 50, 10).unwrap();
    for rotation in 0..4 {
        for mirror in [None, Some(0), Some(1)] {
            let bytes = crate::avif_boxes::encoder_tests::mux_avif(
                &base,
                Some(rotation),
                mirror,
                Some(&set_exif_orientation(&[], 6)),
                Some(XMP),
            );
            assert_parity(&bytes, &format!("AVIF irot{rotation} imir{mirror:?}"));
        }
    }
}
