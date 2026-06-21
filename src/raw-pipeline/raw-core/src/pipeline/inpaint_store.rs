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
}
