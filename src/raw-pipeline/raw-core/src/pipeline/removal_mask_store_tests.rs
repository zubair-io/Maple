use super::*;

fn sample() -> RemovalMask {
    RemovalMask {
        source_width: 100,
        source_height: 80,
        x: 31,
        y: 17,
        width: 3,
        height: 3,
        pixels: vec![255, 0, 255, 0, 255, 0, 255, 0, 255],
    }
}

#[test]
fn canonical_packed_bits_and_real_file_round_trip() {
    let mask = sample();
    let bytes = removal_mask_to_bytes(&mask).unwrap();
    assert_eq!(bytes.len(), 34);
    assert_eq!(&bytes[32..], &[0b01010101, 1]);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("accepted.mimf");
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(
        removal_mask_from_bytes(&std::fs::read(&path).unwrap()).unwrap(),
        mask
    );
    assert_eq!(
        removal_mask_to_bytes(&removal_mask_from_bytes(&bytes).unwrap()).unwrap(),
        bytes
    );
}

#[test]
fn malformed_header_window_body_and_padding_fail() {
    let good = removal_mask_to_bytes(&sample()).unwrap();
    for len in [0, 3, 31, 32, 33] {
        assert!(removal_mask_from_bytes(&good[..len]).is_err());
    }
    for offset in [0, 4, 6, 33] {
        let mut bad = good.clone();
        bad[offset] = 255;
        assert!(removal_mask_from_bytes(&bad).is_err(), "offset={offset}");
    }
    let mut extra = good.clone();
    extra.push(0);
    assert!(removal_mask_from_bytes(&extra).is_err());
    for (offset, value) in [(8, 0u32), (16, u32::MAX), (20, 79), (24, 0), (28, 100)] {
        let mut bad = good.clone();
        bad[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        assert!(removal_mask_from_bytes(&bad).is_err());
    }
}

#[test]
fn writer_rejects_non_binary_and_length_mismatch() {
    let mut mask = sample();
    mask.pixels[0] = 254;
    assert!(removal_mask_to_bytes(&mask).is_err());
    mask = sample();
    mask.pixels.pop();
    assert!(removal_mask_to_bytes(&mask).is_err());
}

#[test]
fn hostile_dimensions_are_rejected_before_allocation() {
    let mut bytes = removal_mask_to_bytes(&sample()).unwrap();
    for offset in [8, 12, 24, 28] {
        bytes[offset..offset + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    }
    bytes[16..24].fill(0);
    assert!(removal_mask_from_bytes(&bytes).is_err());
}
