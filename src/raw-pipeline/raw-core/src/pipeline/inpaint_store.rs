//! On-disk codec for a baked [`InpaintPatch`] — the `.maple/inpaint/<hash>.f16`
//! synthetic-raw store (design doc §3e). Pixels + coverage are stored as fp16
//! (half the size of f32, preserves the linear-light headroom above 1.0 that a
//! 16-bit-int normalization would clip); placement stays f32 for precision.
//!
//! This is the byte codec only — the host owns the directory, content-addressing
//! (blake3), and durable asset publication. Accepted pixels are not an evictable
//! cache: hosts must retain assets referenced by edits/history. Pure codec, no I/O.

use super::fp16::{f16_bits_to_f32, f32_to_f16_bits};
use crate::types::inpaint::validate_patch_layout;
use crate::types::InpaintPatch;

/// File magic: "Maple InPaint Fp16".
const MAGIC: &[u8; 4] = b"MIPF";
/// Header layout version.
const VERSION: u16 = 1;
/// Fixed header size: magic(4) + version(2) + reserved(2) + w(4) + h(4)
/// + origin(2×4) + extent(2×4) = 32 bytes.
const HEADER_LEN: usize = 32;

/// Serialize a patch to the `.f16` byte layout. Pixels and coverage are written
/// in row-major order. Invalid values and RGB that would overflow fp16 are
/// rejected; quantization must never turn a valid scene value into infinity.
pub fn patch_to_bytes(patch: &InpaintPatch) -> Result<Vec<u8>, String> {
    patch.validate()?;
    let n = validate_patch_layout(patch.width, patch.height, patch.origin, patch.extent)?;
    let len = record_len(n)?;
    if patch
        .pixels
        .iter()
        .flatten()
        .any(|c| !f16_bits_to_f32(f32_to_f16_bits(*c)).is_finite())
    {
        return Err("inpaint patch: RGB exceeds finite fp16 storage range".into());
    }
    let mut out = Vec::with_capacity(len);
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
    Ok(out)
}

fn record_len(n: usize) -> Result<usize, String> {
    n.checked_mul(8)
        .and_then(|body| HEADER_LEN.checked_add(body))
        .ok_or_else(|| "inpaint patch: body size overflow".to_string())
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
    if bytes[6..8] != [0, 0] {
        return Err("inpaint patch: unsupported reserved header flags".into());
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
    let expected = record_len(n)?;
    if bytes.len() != expected {
        return Err(format!(
            "inpaint patch: length {} != expected {expected} for {width}x{height}",
            bytes.len()
        ));
    }
    validate_patch_layout(width, height, origin, extent)?;

    let mut off = HEADER_LEN;
    let rd_f16 = |o: usize| f16_bits_to_f32(u16::from_le_bytes([bytes[o], bytes[o + 1]]));
    // Preflight samples before allocating the decoded body. Scene RGB has no
    // [0,1] bound, but coverage does, and neither may contain NaN or infinity.
    let rgb_end = HEADER_LEN + n * 6; // record_len already checked the larger size
    if (HEADER_LEN..rgb_end)
        .step_by(2)
        .any(|o| !rd_f16(o).is_finite())
    {
        return Err("inpaint patch: RGB must be finite".into());
    }
    if (rgb_end..expected)
        .step_by(2)
        .any(|o| !(0.0..=1.0).contains(&rd_f16(o)))
    {
        return Err("inpaint patch: coverage must be finite and in [0, 1]".into());
    }
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
pub fn patches_to_blob(patches: &[InpaintPatch]) -> Result<Vec<u8>, String> {
    let count =
        u32::try_from(patches.len()).map_err(|_| "inpaint blob: count overflow".to_string())?;
    let mut out = count.to_le_bytes().to_vec();
    for p in patches {
        out.extend_from_slice(&patch_to_bytes(p)?);
    }
    Ok(out)
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
        // Every step is checked, including the inner `HEADER_LEN + body`: `body`
        // survives `checked_mul(8)` at up to `usize::MAX - 7`, so adding the
        // header to it wraps for dimensions a blob can legitimately declare
        // (w = 2147483646, h = 1073741825 both fit u32 and land there). A wrap
        // here is a panic in debug and a tiny `end` that slips past the bounds
        // check below in release.
        let end = off
            .checked_add(HEADER_LEN)
            .and_then(|o| o.checked_add(body))
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
#[path = "inpaint_store_tests.rs"]
mod tests;
