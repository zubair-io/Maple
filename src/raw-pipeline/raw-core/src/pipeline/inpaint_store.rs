//! On-disk codec for a baked [`InpaintPatch`] — the `.maple/inpaint/<hash>.f16`
//! synthetic-raw store (design doc §3e). Pixels + coverage are stored as fp16
//! (half the size of f32, preserves the linear-light headroom above 1.0 that a
//! 16-bit-int normalization would clip); placement stays f32 for precision.
//!
//! This is the byte codec only — the host owns the directory, content-addressing
//! (blake3), and the LRU sweep (which must stay scoped to `.maple/inpaint/` and
//! never touch originals). Pure encode/decode, no filesystem access here.
//!
//! Both directions are checked: a patch that is not a finite, in-frame,
//! correctly sized asset with coverage in `[0, 1]` is refused with a
//! [`PatchCodecError`] rather than written or returned. Scene RGB is unbounded
//! (negative and above-one values are valid) but must be finite and must not
//! round to an fp16 infinity.

use super::fp16::{f16_bits_to_f32, f32_to_f16_bits};
use crate::types::inpaint::patch_sample_count;
use crate::types::{InpaintPatch, InpaintPatchError};

/// File magic: "Maple InPaint Fp16".
const MAGIC: &[u8; 4] = b"MIPF";
/// Header layout version.
const VERSION: u16 = 1;
/// Fixed header size: magic(4) + version(2) + reserved(2) + w(4) + h(4)
/// + origin(2×4) + extent(2×4) = 32 bytes.
const HEADER_LEN: usize = 32;
const RGB_BYTES: usize = 6;
const SAMPLE_BYTES: usize = 8;
/// fp16 exponent field; all ones marks infinity or NaN.
const F16_EXPONENT: u16 = 0x7c00;

/// Why a patch or patch blob was refused by the `.f16` codec.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum PatchCodecError {
    #[error(transparent)]
    Layout(#[from] InpaintPatchError),
    #[error("inpaint patch: non-finite RGB at sample {index}")]
    NonFiniteRgb { index: usize },
    #[error("inpaint patch: RGB {value} at sample {index} overflows fp16 storage")]
    Fp16Overflow { index: usize, value: f32 },
    #[error("inpaint patch: coverage {value} at sample {index} is outside [0, 1]")]
    Coverage { index: usize, value: f32 },
    #[error("inpaint patch: truncated header ({len} < 32 bytes)")]
    TruncatedHeader { len: usize },
    #[error("inpaint patch: bad magic")]
    BadMagic,
    #[error("inpaint patch: unsupported version {found}")]
    UnsupportedVersion { found: u16 },
    #[error("inpaint patch: unsupported reserved header flags {found:#06x}")]
    ReservedFlags { found: u16 },
    #[error("inpaint patch: length {found} != expected {expected} for {width}x{height}")]
    LengthMismatch {
        found: usize,
        expected: usize,
        width: u32,
        height: u32,
    },
    #[error("inpaint blob: truncated count ({len} < 4 bytes)")]
    BlobTruncatedCount { len: usize },
    #[error(
        "inpaint blob: count {count} exceeds what {remaining} remaining bytes can hold ({max})"
    )]
    BlobCount {
        count: usize,
        remaining: usize,
        max: usize,
    },
    #[error("inpaint blob: truncated record for patch {index}")]
    BlobTruncatedRecord { index: usize },
    #[error("inpaint blob: {extra} trailing byte(s) after {count} patch(es)")]
    BlobTrailingBytes { extra: usize, count: usize },
    #[error("inpaint blob: patch {index}: {source}")]
    BlobPatch {
        index: usize,
        source: Box<PatchCodecError>,
    },
    #[error("inpaint blob: {count} patches exceed the u32 count field")]
    BlobTooManyPatches { count: usize },
}

/// Byte length of one record, with every step checked: the sample count must
/// fit `u32` (the compositor's index type) and the body plus header must fit
/// `usize`, which a 32-bit target can overflow for dimensions that fit `u32`.
fn record_len(width: u32, height: u32) -> Result<usize, PatchCodecError> {
    width
        .checked_mul(height)
        .and_then(|samples| (samples as usize).checked_mul(SAMPLE_BYTES))
        .and_then(|body| body.checked_add(HEADER_LEN))
        .ok_or(PatchCodecError::Layout(
            InpaintPatchError::DimensionOverflow { width, height },
        ))
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn half_at(bytes: &[u8], offset: usize) -> f32 {
    f16_bits_to_f32(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))
}

/// Serialize a patch to the `.f16` byte layout, pixels and coverage in the
/// patch's row-major order.
///
/// # Errors
/// Refuses a patch whose layout fails [`InpaintPatch::check_layout`], whose RGB
/// is not finite or would round to an fp16 infinity (|value| ≥ 65520), or whose
/// coverage is outside `[0, 1]`. Nothing is clipped or saturated.
pub fn patch_to_bytes(patch: &InpaintPatch) -> Result<Vec<u8>, PatchCodecError> {
    patch.check_layout()?;
    let mut out = Vec::with_capacity(record_len(patch.width, patch.height)?);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
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
    for (index, px) in patch.pixels.iter().enumerate() {
        for &value in px {
            if !value.is_finite() {
                return Err(PatchCodecError::NonFiniteRgb { index });
            }
            let bits = f32_to_f16_bits(value);
            if bits & F16_EXPONENT == F16_EXPONENT {
                return Err(PatchCodecError::Fp16Overflow { index, value });
            }
            out.extend_from_slice(&bits.to_le_bytes());
        }
    }
    for (index, &value) in patch.coverage.iter().enumerate() {
        if !(0.0..=1.0).contains(&value) {
            return Err(PatchCodecError::Coverage { index, value });
        }
        out.extend_from_slice(&f32_to_f16_bits(value).to_le_bytes());
    }
    Ok(out)
}

/// Parse a patch from the `.f16` byte layout.
///
/// # Errors
/// Refuses a record with the wrong magic, version or reserved flags, a byte
/// length that does not match its declared dimensions, zero or overflowing
/// dimensions, a non-finite or out-of-frame placement, non-finite RGB, or
/// coverage outside `[0, 1]`.
pub fn patch_from_bytes(bytes: &[u8]) -> Result<InpaintPatch, PatchCodecError> {
    if bytes.len() < HEADER_LEN {
        return Err(PatchCodecError::TruncatedHeader { len: bytes.len() });
    }
    if &bytes[0..4] != MAGIC {
        return Err(PatchCodecError::BadMagic);
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if version != VERSION {
        return Err(PatchCodecError::UnsupportedVersion { found: version });
    }
    let reserved = u16::from_le_bytes([bytes[6], bytes[7]]);
    if reserved != 0 {
        return Err(PatchCodecError::ReservedFlags { found: reserved });
    }
    let width = u32_at(bytes, 8);
    let height = u32_at(bytes, 12);
    let rd_f32 = |o: usize| f32::from_bits(u32_at(bytes, o));
    let origin = [rd_f32(16), rd_f32(20)];
    let extent = [rd_f32(24), rd_f32(28)];

    let expected = record_len(width, height)?;
    if bytes.len() != expected {
        return Err(PatchCodecError::LengthMismatch {
            found: bytes.len(),
            expected,
            width,
            height,
        });
    }
    let samples = patch_sample_count(width, height, origin, extent)?;

    let (rgb, alpha) = bytes[HEADER_LEN..].split_at(samples * RGB_BYTES);
    let pixels: Vec<[f32; 3]> = rgb
        .chunks_exact(RGB_BYTES)
        .map(|px| [half_at(px, 0), half_at(px, 2), half_at(px, 4)])
        .collect();
    if let Some(index) = pixels
        .iter()
        .position(|px| px.iter().any(|lane| !lane.is_finite()))
    {
        return Err(PatchCodecError::NonFiniteRgb { index });
    }
    let coverage: Vec<f32> = alpha.chunks_exact(2).map(|c| half_at(c, 0)).collect();
    if let Some((index, &value)) = coverage
        .iter()
        .enumerate()
        .find(|(_, value)| !(0.0..=1.0).contains(*value))
    {
        return Err(PatchCodecError::Coverage { index, value });
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
///
/// # Errors
/// Refuses the whole blob when any patch fails [`patch_to_bytes`].
pub fn patches_to_blob(patches: &[InpaintPatch]) -> Result<Vec<u8>, PatchCodecError> {
    let count = u32::try_from(patches.len()).map_err(|_| PatchCodecError::BlobTooManyPatches {
        count: patches.len(),
    })?;
    let mut out = count.to_le_bytes().to_vec();
    for p in patches {
        out.extend_from_slice(&patch_to_bytes(p)?);
    }
    Ok(out)
}

/// Inverse of [`patches_to_blob`]. Validates the count, then walks each record
/// by computing its length from the per-patch header (`HEADER_LEN + w*h*8`).
/// The blob crosses the FFI boundary, so it is treated as untrusted.
///
/// # Errors
/// Refuses the whole blob on a truncated count, header or body, on trailing
/// bytes, and when any one record fails [`patch_from_bytes`].
pub fn patches_from_blob(bytes: &[u8]) -> Result<Vec<InpaintPatch>, PatchCodecError> {
    if bytes.len() < 4 {
        return Err(PatchCodecError::BlobTruncatedCount { len: bytes.len() });
    }
    let count = u32_at(bytes, 0) as usize;
    // The count is untrusted: every patch costs at least HEADER_LEN bytes, so a
    // blob of this length cannot describe more than `remaining / HEADER_LEN` of
    // them. Bound the reservation by that ceiling rather than trusting `count`,
    // or a malformed header claiming u32::MAX patches aborts the process on the
    // allocation before any of the truncation checks below can run.
    let remaining = bytes.len() - 4;
    let max = remaining / HEADER_LEN;
    if count > max {
        return Err(PatchCodecError::BlobCount {
            count,
            remaining,
            max,
        });
    }
    let mut off = 4;
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        if bytes.len() - off < HEADER_LEN {
            return Err(PatchCodecError::BlobTruncatedRecord { index });
        }
        let in_patch = |source: PatchCodecError| PatchCodecError::BlobPatch {
            index,
            source: Box::new(source),
        };
        let len = record_len(u32_at(bytes, off + 8), u32_at(bytes, off + 12)).map_err(in_patch)?;
        if bytes.len() - off < len {
            return Err(PatchCodecError::BlobTruncatedRecord { index });
        }
        out.push(patch_from_bytes(&bytes[off..off + len]).map_err(in_patch)?);
        off += len;
    }
    // Trailing bytes mean the blob does not describe what it claims — surface
    // that rather than silently dropping removals from a corrupt cache entry.
    if off != bytes.len() {
        return Err(PatchCodecError::BlobTrailingBytes {
            extra: bytes.len() - off,
            count,
        });
    }
    Ok(out)
}

#[cfg(test)]
#[path = "inpaint_store_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "inpaint_store_validation_tests.rs"]
mod validation_tests;
