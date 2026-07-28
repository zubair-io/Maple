//! On-disk codec for a baked [`InpaintPatch`] — the `.maple/inpaint/<hash>.f16`
//! synthetic-raw store (design doc §3e). Pixels + coverage are stored as fp16
//! (half the size of f32, preserves the linear-light headroom above 1.0 that a
//! 16-bit-int normalization would clip); placement stays f32 for precision.
//!
//! This is the byte codec only — the host owns the directory, content-addressing
//! (blake3), and the LRU sweep (which must stay scoped to `.maple/inpaint/` and
//! never touch originals). Pure encode/decode, no filesystem access here.

use super::fp16::{f16_bits_to_f32, f32_to_f16_bits};
use crate::types::InpaintPatch;

/// File magic: "Maple InPaint Fp16".
const MAGIC: &[u8; 4] = b"MIPF";
/// Header layout version.
const VERSION: u16 = 1;
/// Fixed header size: magic(4) + version(2) + reserved(2) + w(4) + h(4)
/// + origin(2×4) + extent(2×4) = 32 bytes.
const HEADER_LEN: usize = 32;

/// Serialize a patch to the `.f16` byte layout. Pixels and coverage are written
/// in the patch's declared row-major order; on a malformed patch (buffer length
/// ≠ `width*height`) the result simply won't round-trip — callers serialize
/// validated patches ([`InpaintPatch::is_valid`]).
pub fn patch_to_bytes(patch: &InpaintPatch) -> Vec<u8> {
    let n = (patch.width as usize) * (patch.height as usize);
    let mut out = Vec::with_capacity(HEADER_LEN + n * 3 * 2 + n * 2);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&patch.width.to_le_bytes());
    out.extend_from_slice(&patch.height.to_le_bytes());
    for v in [
        patch.origin[0],
        patch.origin[1],
        patch.extent[0],
        patch.extent[1],
    ] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for px in &patch.pixels {
        for &c in px {
            out.extend_from_slice(&f32_to_f16_bits(c).to_le_bytes());
        }
    }
    for &cov in &patch.coverage {
        out.extend_from_slice(&f32_to_f16_bits(cov).to_le_bytes());
    }
    out
}

/// Parse a patch from the `.f16` byte layout. Validates magic, version, and that
/// the byte length matches the declared dimensions.
pub fn patch_from_bytes(bytes: &[u8]) -> Result<InpaintPatch, String> {
    if bytes.len() < HEADER_LEN {
        return Err(format!(
            "inpaint patch: truncated header ({} < {HEADER_LEN} bytes)",
            bytes.len()
        ));
    }
    if &bytes[0..4] != MAGIC {
        return Err("inpaint patch: bad magic".to_string());
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if version != VERSION {
        return Err(format!("inpaint patch: unsupported version {version}"));
    }
    let width = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    let height = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);
    let rd_f32 =
        |o: usize| f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let origin = [rd_f32(16), rd_f32(20)];
    let extent = [rd_f32(24), rd_f32(28)];

    let n = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| "inpaint patch: dimension overflow".to_string())?;
    let body = n
        .checked_mul(3 * 2 + 2) // 3 fp16 pixel lanes + 1 fp16 coverage lane
        .ok_or_else(|| "inpaint patch: body size overflow".to_string())?;
    let expected = HEADER_LEN + body;
    if bytes.len() != expected {
        return Err(format!(
            "inpaint patch: length {} != expected {expected} for {width}x{height}",
            bytes.len()
        ));
    }

    let mut off = HEADER_LEN;
    let rd_f16 = |o: usize| f16_bits_to_f32(u16::from_le_bytes([bytes[o], bytes[o + 1]]));
    let mut pixels = Vec::with_capacity(n);
    for _ in 0..n {
        pixels.push([rd_f16(off), rd_f16(off + 2), rd_f16(off + 4)]);
        off += 6;
    }
    let mut coverage = Vec::with_capacity(n);
    for _ in 0..n {
        coverage.push(rd_f16(off));
        off += 2;
    }
    Ok(InpaintPatch {
        width,
        height,
        origin,
        extent,
        pixels,
        coverage,
    })
}

/// Concatenate multiple patches into one FFI transport blob:
/// `[u32 count][patch0][patch1]…`, each `patchK` the self-describing
/// [`patch_to_bytes`] record (its header carries `w`/`h`, so the decoder walks
/// records without a separate length table). Empty input → 4-byte `count=0`.
/// Used to hand a render's active patch set across the C-ABI in one pointer.
pub fn patches_to_blob(patches: &[InpaintPatch]) -> Vec<u8> {
    let mut out = (patches.len() as u32).to_le_bytes().to_vec();
    for p in patches {
        out.extend_from_slice(&patch_to_bytes(p));
    }
    out
}

/// Inverse of [`patches_to_blob`]. Validates the count, then walks each record
/// by computing its length from the per-patch header (`HEADER_LEN + w*h*8`).
/// Errors on a truncated count / header / body rather than reading out of
/// bounds — the blob crosses the FFI boundary, so it is treated as untrusted.
pub fn patches_from_blob(bytes: &[u8]) -> Result<Vec<InpaintPatch>, String> {
    if bytes.len() < 4 {
        return Err(format!(
            "inpaint blob: truncated count ({} < 4 bytes)",
            bytes.len()
        ));
    }
    let count = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    // The count is untrusted: every patch costs at least HEADER_LEN bytes, so a
    // blob of this length cannot describe more than `remaining / HEADER_LEN` of
    // them. Bound the reservation by that ceiling rather than trusting `count`,
    // or a malformed header claiming u32::MAX patches aborts the process on the
    // allocation before any of the truncation checks below can run.
    let max_possible = (bytes.len() - 4) / HEADER_LEN;
    if count > max_possible {
        return Err(format!(
            "inpaint blob: count {count} exceeds what {} remaining bytes can hold ({max_possible})",
            bytes.len() - 4
        ));
    }
    let mut off = 4;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        if bytes.len() < off + HEADER_LEN {
            return Err(format!("inpaint blob: truncated header for patch {i}"));
        }
        // `width`/`height` live at byte offsets 8 and 12 within the record header.
        let w = u32::from_le_bytes([
            bytes[off + 8],
            bytes[off + 9],
            bytes[off + 10],
            bytes[off + 11],
        ]) as usize;
        let h = u32::from_le_bytes([
            bytes[off + 12],
            bytes[off + 13],
            bytes[off + 14],
            bytes[off + 15],
        ]) as usize;
        let n = w
            .checked_mul(h)
            .ok_or_else(|| format!("inpaint blob: patch {i} dimension overflow"))?;
        // 3 fp16 pixel lanes + 1 fp16 coverage lane = 8 bytes/pixel.
        let body = n
            .checked_mul(8)
            .ok_or_else(|| format!("inpaint blob: patch {i} body overflow"))?;
        let end = off
            .checked_add(HEADER_LEN + body)
            .ok_or_else(|| format!("inpaint blob: patch {i} offset overflow"))?;
        if bytes.len() < end {
            return Err(format!("inpaint blob: truncated body for patch {i}"));
        }
        out.push(patch_from_bytes(&bytes[off..end])?);
        off = end;
    }
    // Trailing bytes mean the blob does not describe what it claims — surface
    // that rather than silently dropping removals from a corrupt cache entry.
    if off != bytes.len() {
        return Err(format!(
            "inpaint blob: {} trailing byte(s) after {count} patch(es)",
            bytes.len() - off
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
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
        let bytes = patch_to_bytes(&p);
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
        let mut bytes = patch_to_bytes(&sample());
        bytes[0] = b'X';
        assert!(patch_from_bytes(&bytes).is_err());
    }

    #[test]
    fn truncated_errors() {
        let bytes = patch_to_bytes(&sample());
        assert!(patch_from_bytes(&bytes[..HEADER_LEN - 1]).is_err());
        assert!(patch_from_bytes(&bytes[..bytes.len() - 2]).is_err());
    }

    #[test]
    fn wrong_version_errors() {
        let mut bytes = patch_to_bytes(&sample());
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
        let blob = patches_to_blob(&[a.clone(), b.clone()]);
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
        let blob = patches_to_blob(&[]);
        assert_eq!(blob, 0u32.to_le_bytes().to_vec());
        assert!(patches_from_blob(&blob).unwrap().is_empty());
    }

    #[test]
    fn blob_truncated_errors() {
        let blob = patches_to_blob(&[sample()]);
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
        let good = patches_to_blob(std::slice::from_ref(&patch));
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
}
