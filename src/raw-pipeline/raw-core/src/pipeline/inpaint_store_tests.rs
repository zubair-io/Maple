//! Round-trip and framing tests for the `.f16` patch codec.

use super::*;

#[test]
fn shadow_pixels_and_coverage_roundtrip_without_subnormal_bias() {
    // #4211: exact IEEE half values prove actual durable/blob transport,
    // not the former loose 0.01 absolute tolerance that hides shadow loss.
    let pixels = (1..=0x0400)
        .map(|bits| {
            let value = half::f16::from_bits(bits).to_f32();
            [value, -value, value]
        })
        .collect::<Vec<_>>();
    let coverage = pixels.iter().map(|p| p[0]).collect::<Vec<_>>();
    let patch = InpaintPatch {
        width: 1024,
        height: 1,
        origin: [0.0, 0.0],
        extent: [1.0, 1.0],
        pixels,
        coverage,
    };
    let bytes = patch_to_bytes(&patch).unwrap();
    assert_eq!(&bytes[..8], b"MIPF\x01\x00\x00\x00");
    assert_eq!(&bytes[32..38], &[1, 0, 1, 128, 1, 0]);
    let decoded = patch_from_bytes(&bytes).unwrap();
    assert_eq!(decoded.pixels, patch.pixels);
    assert_eq!(decoded.coverage, patch.coverage);
    let blob = patches_to_blob(std::slice::from_ref(&patch)).unwrap();
    let relayed = patches_from_blob(&blob).unwrap();
    assert_eq!(relayed[0].pixels, patch.pixels);
    assert_eq!(relayed[0].coverage, patch.coverage);
}

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
        err.to_string().contains("exceeds what"),
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
        err.to_string().contains("overflow") || err.to_string().contains("truncated"),
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
        err.to_string().contains("trailing"),
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

/// Subnormal pixel/coverage values (e.g. 2^-15, 2^-20) must roundtrip faithfully (#4211).
#[test]
fn subnormal_patch_values_roundtrip_faithfully() {
    let p = InpaintPatch {
        width: 1,
        height: 1,
        origin: [0.0, 0.0],
        extent: [1.0, 1.0],
        pixels: vec![[2.0f32.powi(-15), 2.0f32.powi(-16), 2.0f32.powi(-20)]],
        coverage: vec![2.0f32.powi(-15)],
    };
    let bytes = patch_to_bytes(&p).unwrap();
    let back = patch_from_bytes(&bytes).expect("decode");
    assert_eq!(back.pixels[0][0], 2.0f32.powi(-15));
    assert_eq!(back.pixels[0][1], 2.0f32.powi(-16));
    assert_eq!(back.pixels[0][2], 2.0f32.powi(-20));
    assert_eq!(back.coverage[0], 2.0f32.powi(-15));
}
