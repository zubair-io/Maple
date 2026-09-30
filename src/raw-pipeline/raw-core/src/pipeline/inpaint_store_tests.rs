//! Corruption and round-trip tests for the durable patch codec.
use super::*;

fn sample() -> InpaintPatch {
    // 3×2 patch with varied values, including a >1.0 highlight (headroom).
    InpaintPatch {
        width: 3,
        height: 2,
        origin: [0.25, 0.5],
        extent: [0.5, 0.25],
        pixels: vec![
            [0.18, 0.10, 0.05],
            [0.50, 0.40, 0.30],
            [2.5, 1.2, 0.8],
            [0.0, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.02, 0.03, 0.04],
        ],
        coverage: vec![1.0, 0.5, 0.0, 0.75, 1.0, 0.25],
    }
}

#[test]
fn roundtrips_header_and_pixels() {
    let p = sample();
    let bytes = patch_to_bytes(&p).unwrap();
    let back = patch_from_bytes(&bytes).expect("decode");
    assert_eq!(back.width, p.width);
    assert_eq!(back.height, p.height);
    assert_eq!(back.origin, p.origin); // f32, exact
    assert_eq!(back.extent, p.extent);
    assert_eq!(back.pixels.len(), p.pixels.len());
    for (a, b) in back.pixels.iter().zip(p.pixels.iter()) {
        for c in 0..3 {
            // fp16 quantization tolerance (coarser for the >1.0 highlight).
            let tol = 0.01 * b[c].abs().max(1.0);
            assert!((a[c] - b[c]).abs() <= tol, "pixel {:?} vs {:?}", a, b);
        }
    }
    for (a, b) in back.coverage.iter().zip(p.coverage.iter()) {
        assert!((a - b).abs() < 1e-3, "coverage {a} vs {b}");
    }
    assert!(back.is_valid());
}

#[test]
fn bad_magic_errors() {
    let mut bytes = patch_to_bytes(&sample()).unwrap();
    bytes[0] = b'X';
    assert!(patch_from_bytes(&bytes).is_err());
}

#[test]
fn truncated_errors() {
    let bytes = patch_to_bytes(&sample()).unwrap();
    assert!(patch_from_bytes(&bytes[..HEADER_LEN - 1]).is_err());
    assert!(patch_from_bytes(&bytes[..bytes.len() - 2]).is_err());
}

#[test]
fn wrong_version_errors() {
    let mut bytes = patch_to_bytes(&sample()).unwrap();
    bytes[4] = 0xFF;
    bytes[5] = 0xFF;
    assert!(patch_from_bytes(&bytes).is_err());
}

#[test]
fn blob_round_trips_variable_size_patches() {
    let a = sample(); // 3×2
    let mut b = sample();
    b.width = 2;
    b.height = 2;
    b.pixels = vec![[0.1, 0.2, 0.3]; 4];
    b.coverage = vec![0.5; 4];
    let blob = patches_to_blob(&[a.clone(), b.clone()]).unwrap();
    let back = patches_from_blob(&blob).expect("decode blob");
    assert_eq!(back.len(), 2);
    for (got, want) in back.iter().zip([&a, &b]) {
        assert_eq!(got.width, want.width);
        assert_eq!(got.height, want.height);
        assert_eq!(got.origin, want.origin);
        assert_eq!(got.extent, want.extent);
        assert_eq!(got.pixels.len(), want.pixels.len());
        assert!(got.is_valid());
    }
}

#[test]
fn blob_empty_is_count_zero() {
    let blob = patches_to_blob(&[]).unwrap();
    assert_eq!(blob, 0u32.to_le_bytes().to_vec());
    assert!(patches_from_blob(&blob).unwrap().is_empty());
}

#[test]
fn blob_truncated_errors() {
    let blob = patches_to_blob(&[sample()]).unwrap();
    assert!(patches_from_blob(&blob[..2]).is_err()); // truncated count
    assert!(patches_from_blob(&blob[..10]).is_err()); // truncated header
    assert!(patches_from_blob(&blob[..blob.len() - 4]).is_err()); // truncated body
}

#[test]
fn blob_overlong_count_errors() {
    // Count claims 5 patches but there is no body to back it.
    let mut blob = 5u32.to_le_bytes().to_vec();
    blob.extend_from_slice(&[0u8; 4]);
    assert!(patches_from_blob(&blob).is_err());
}
/// A malformed header claiming a huge patch count must be rejected from the
/// blob length alone, BEFORE `Vec::with_capacity` — otherwise an untrusted
/// blob crossing the FFI boundary aborts the process on the allocation.
#[test]
fn absurd_count_is_rejected_without_allocating() {
    let mut blob = u32::MAX.to_le_bytes().to_vec();
    blob.extend_from_slice(&[0u8; 16]);
    let err = patches_from_blob(&blob).expect_err("absurd count must error");
    assert!(
        err.contains("exceeds what"),
        "expected the length-bound rejection, got: {err}"
    );
}

/// The per-patch body length must not be able to wrap the offset math.
/// `w * h * 8` can survive its own `checked_mul` at `usize::MAX - 15` while
/// `HEADER_LEN + body` still overflows, so the header addition has to be
/// checked too — otherwise this input panics in debug and, in release,
/// wraps `end` down to a value that slips past the truncation check.
/// These dimensions are the smallest pair that both fit `u32` and land in
/// that window: 2147483646 * 1073741825 * 8 == usize::MAX - 15.
#[test]
fn body_length_cannot_wrap_the_offset_math() {
    let mut blob = 1u32.to_le_bytes().to_vec();
    blob.extend_from_slice(&[0u8; 8]); // origin/extent lead-in
    blob.extend_from_slice(&2147483646u32.to_le_bytes());
    blob.extend_from_slice(&1073741825u32.to_le_bytes());
    blob.extend_from_slice(&[0u8; HEADER_LEN - 16]); // rest of the header
    let err = patches_from_blob(&blob).expect_err("wrapping body must error");
    assert!(
        err.contains("overflow") || err.contains("truncated"),
        "expected an overflow/truncation rejection, got: {err}"
    );
}

/// Trailing bytes mean the blob does not describe what it claims; treating
/// it as valid would silently drop removals from a corrupt cache entry.
#[test]
fn trailing_bytes_are_rejected() {
    let patch = InpaintPatch {
        width: 2,
        height: 2,
        origin: [0.0, 0.0],
        extent: [1.0, 1.0],
        pixels: vec![[0.25, 0.5, 0.75]; 4],
        coverage: vec![1.0; 4],
    };
    let good = patches_to_blob(std::slice::from_ref(&patch)).unwrap();
    assert!(patches_from_blob(&good).is_ok(), "control blob must decode");

    let mut trailing = good.clone();
    trailing.extend_from_slice(&[0xAB; 3]);
    let err = patches_from_blob(&trailing).expect_err("trailing bytes must error");
    assert!(
        err.contains("trailing"),
        "expected the trailing-byte rejection, got: {err}"
    );
}

/// The empty blob stays valid — it is the "no removals" encoding.
#[test]
fn empty_blob_still_decodes_to_no_patches() {
    let blob = 0u32.to_le_bytes().to_vec();
    assert!(patches_from_blob(&blob)
        .expect("empty blob decodes")
        .is_empty());
}

#[test]
fn negative_rgb_and_hdr_survive_storage_without_clipping() {
    let mut p = sample();
    p.pixels[0] = [-2.0, 8.0, 65504.0];
    let decoded = patch_from_bytes(&patch_to_bytes(&p).unwrap()).unwrap();
    assert_eq!(decoded.pixels[0], p.pixels[0]);
}

#[test]
fn checked_writer_rejects_invalid_or_overflowing_samples() {
    for value in [
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
        65520.0,
        -65520.0,
    ] {
        let mut p = sample();
        p.pixels[0][0] = value;
        assert!(patch_to_bytes(&p).is_err(), "accepted RGB {value}");
        assert!(patches_to_blob(&[p]).is_err());
    }
    for value in [f32::NAN, f32::INFINITY, -0.001, 1.001] {
        let mut p = sample();
        p.coverage[0] = value;
        assert!(patch_to_bytes(&p).is_err(), "accepted coverage {value}");
    }
    let mut p = sample();
    p.pixels.pop();
    assert!(patch_to_bytes(&p).is_err());
}

#[test]
fn reader_rejects_non_finite_rgb_and_invalid_coverage() {
    for bits in [0x7c00u16, 0xfc00, 0x7e00] {
        let mut bytes = patch_to_bytes(&sample()).unwrap();
        bytes[HEADER_LEN..HEADER_LEN + 2].copy_from_slice(&bits.to_le_bytes());
        assert!(patch_from_bytes(&bytes).is_err());
    }
    for bits in [0x7c00u16, 0x7e00, 0xbc00, 0x4000] {
        let mut bytes = patch_to_bytes(&sample()).unwrap();
        let off = HEADER_LEN + 3 * 2 * 6;
        bytes[off..off + 2].copy_from_slice(&bits.to_le_bytes());
        assert!(patch_from_bytes(&bytes).is_err());
    }
}

#[test]
fn reader_rejects_invalid_placement_and_reserved_flags() {
    for (offset, value) in [(16, -0.1), (20, f32::NAN), (24, 0.0), (28, 0.8)] {
        let mut bytes = patch_to_bytes(&sample()).unwrap();
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        assert!(
            patch_from_bytes(&bytes).is_err(),
            "accepted header {offset}={value}"
        );
    }
    let mut bytes = patch_to_bytes(&sample()).unwrap();
    bytes[6] = 1;
    assert!(patch_from_bytes(&bytes).is_err());
}

#[test]
fn standalone_header_size_cannot_overflow_or_declare_an_empty_patch() {
    let mut bytes = patch_to_bytes(&sample()).unwrap();
    bytes[8..12].copy_from_slice(&2147483646u32.to_le_bytes());
    bytes[12..16].copy_from_slice(&1073741825u32.to_le_bytes());
    assert!(patch_from_bytes(&bytes).unwrap_err().contains("overflow"));
    let mut empty = bytes[..HEADER_LEN].to_vec();
    empty[8..16].fill(0);
    assert!(patch_from_bytes(&empty).unwrap_err().contains("non-zero"));
}
