use super::*;
use crate::raster_analyze::{analyze, analyze_reader};
use crate::view::encode::TargetPrimaries::{Srgb, P3};

fn encode(channels: u8, profile: Option<&[u8]>) -> Vec<u8> {
    let pixel = if channels == 3 {
        vec![170, 95, 60]
    } else {
        vec![170, 95, 60, 137]
    };
    let raster = RasterImage::from_raw(16, 16, channels, pixel.repeat(256)).unwrap();
    crate::raster_encode_avif::encode_avif_opts(
        &raster,
        &crate::raster_encode_avif::AvifOptions {
            quality: 100,
            effort: 0,
            ..Default::default()
        },
        &crate::raster_encode::EmbeddedMetadata {
            icc: profile,
            ..Default::default()
        },
        P3,
    )
    .unwrap()
}

fn metadata(bytes: &[u8]) -> serde_json::Value {
    let request = r#"{"v":1,"what":["metadata"]}"#;
    let memory: serde_json::Value =
        serde_json::from_str(&analyze(bytes, request).unwrap()).unwrap();
    let file: serde_json::Value =
        serde_json::from_str(&analyze_reader(&mut Cursor::new(bytes), request).unwrap()).unwrap();
    assert_eq!(memory, file);
    memory["metadata"].clone()
}

fn container_cicp(bytes: &[u8], primaries: u16, transfer: u16) -> Vec<u8> {
    let at = bytes.windows(4).position(|b| b == b"nclx").unwrap();
    let mut out = bytes.to_vec();
    out[at + 4..at + 6].copy_from_slice(&primaries.to_be_bytes());
    out[at + 6..at + 8].copy_from_slice(&transfer.to_be_bytes());
    out
}

fn unspecified_sequence(bytes: &[u8]) -> Vec<u8> {
    let item = parse_container(bytes).unwrap().primary_item;
    let at = bytes.windows(item.len()).position(|b| b == &*item).unwrap();
    let bits: Vec<_> = item
        .iter()
        .flat_map(|b| (0..8).rev().map(move |shift| (b >> shift) & 1))
        .collect();
    let description: Vec<_> = [12u8, 13, 6]
        .iter()
        .flat_map(|b| (0..8).rev().map(move |shift| (b >> shift) & 1))
        .collect();
    let matches: Vec<_> = bits
        .windows(24)
        .enumerate()
        .filter(|(_, b)| *b == description)
        .map(|(i, _)| i)
        .collect();
    assert_eq!(matches.len(), 1);
    let mut out = bytes.to_vec();
    for (offset, bit) in [2u8, 2]
        .iter()
        .flat_map(|b| (0..8).rev().map(move |shift| (b >> shift) & 1))
        .enumerate()
    {
        let index = matches[0] + offset;
        let mask = 1 << (7 - index % 8);
        out[at + index / 8] = (out[at + index / 8] & !mask) | (bit << (7 - index % 8));
    }
    let header = sequence_header(&parse_container(&out).unwrap().primary_item).unwrap();
    assert_eq!((header.pri as u32, header.trc as u32), (2, 2));
    out
}

#[test]
fn container_nclx_overrides_sequence_for_pixels() {
    for channels in [3, 4] {
        let encoded = encode(channels, None);
        let unspecified = unspecified_sequence(&encoded);
        assert_eq!(
            decode_avif(&unspecified).unwrap().data,
            decode_avif(&encoded).unwrap().data
        );
        assert!(normalizes_to_srgb(&unspecified).unwrap());
        let meta = metadata(&unspecified);
        assert_eq!(meta["colorPrimaries"], 12);
        assert_eq!(meta["transferCharacteristics"], 13);
        assert_eq!(meta["hasProfile"], false);
        let srgb = container_cicp(&encoded, 1, 13);
        assert!(!normalizes_to_srgb(&srgb).unwrap());
        assert_eq!(metadata(&srgb)["colorPrimaries"], 1);
        assert_ne!(
            decode_avif(&srgb).unwrap().data,
            decode_avif(&encoded).unwrap().data
        );
        assert!(!normalizes_to_srgb(&container_cicp(&encoded, 2, 2)).unwrap());
        let absent = {
            let mut bytes = encoded.clone();
            let at = bytes.windows(4).position(|b| b == b"nclx").unwrap();
            bytes[at - 4..at].copy_from_slice(b"free");
            bytes
        };
        assert!(normalizes_to_srgb(&absent).unwrap());
        assert_eq!(metadata(&absent)["colorPrimaries"], 12);
    }
}

#[test]
fn oversized_avif_icc_is_present_without_returning_profile_bytes() {
    let profile = vec![0; crate::raster_meta::MAX_SIDECAR_BYTES + 1];
    let encoded = encode(3, Some(&profile));
    let meta = metadata(&encoded);
    assert_eq!(meta["hasProfile"], true);
    assert!(meta["icc"].is_null());
}

#[test]
fn keeping_container_only_p3_preserves_normalized_pixels_and_srgb_profile() {
    for channels in [3, 4] {
        let encoded = encode(channels, None);
        let unspecified = unspecified_sequence(&encoded);
        let recipe = crate::raster_recipe::parse_recipe(r#"{"v":1,"input":{"kind":"encoded"},"ops":[],"metadata":{"keep":true},"output":{"format":"png"}}"#).unwrap();
        let output = crate::raster_recipe_exec::run_recipe(&recipe, &unspecified, &[]).unwrap();
        assert_eq!(
            crate::raster_meta::read_sidecars(&output.bytes)
                .icc
                .unwrap(),
            crate::icc::profile_for(Srgb)
        );
        assert_eq!(
            crate::raster::decode_raster(&output.bytes, None)
                .unwrap()
                .data,
            decode_avif(&encoded).unwrap().data
        );
    }
}
