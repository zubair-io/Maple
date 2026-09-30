//! Durable binary intent-mask codec (#3934). MIMF v1 stores native source
//! geometry plus lossless packed bits, independent of inference/runtime.

use crate::types::removal_mask::{validate_mask_layout, RemovalMask};

const HEADER_LEN: usize = 32;

pub fn removal_mask_to_bytes(mask: &RemovalMask) -> Result<Vec<u8>, String> {
    mask.validate()?;
    let n = mask.pixels.len();
    let len = record_len(n)?;
    let mut out = Vec::new();
    out.try_reserve_exact(len)
        .map_err(|_| "removal mask: insufficient memory".to_string())?;
    out.extend_from_slice(b"MIMF");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    for v in [
        mask.source_width,
        mask.source_height,
        mask.x,
        mask.y,
        mask.width,
        mask.height,
    ] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.resize(len, 0);
    for (i, v) in mask.pixels.iter().enumerate() {
        if *v == 255 {
            out[HEADER_LEN + i / 8] |= 1 << (i % 8);
        }
    }
    Ok(out)
}

pub fn removal_mask_from_bytes(bytes: &[u8]) -> Result<RemovalMask, String> {
    if bytes.len() < HEADER_LEN || &bytes[..4] != b"MIMF" {
        return Err("removal mask: missing or invalid header".into());
    }
    if bytes[4..8] != [1, 0, 0, 0] {
        return Err("removal mask: unsupported version or flags".into());
    }
    let read = |offset: usize| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let (source_width, source_height, x, y, width, height) =
        (read(8), read(12), read(16), read(20), read(24), read(28));
    let n = validate_mask_layout(source_width, source_height, x, y, width, height)?;
    if bytes.len() != record_len(n)? {
        return Err("removal mask: body does not match dimensions".into());
    }
    let remainder = n % 8;
    if remainder != 0 && bytes[bytes.len() - 1] >> remainder != 0 {
        return Err("removal mask: non-zero padding bits".into());
    }
    let mut pixels = Vec::new();
    pixels
        .try_reserve_exact(n)
        .map_err(|_| "removal mask: insufficient memory".to_string())?;
    pixels.extend((0..n).map(|i| {
        if bytes[HEADER_LEN + i / 8] & (1 << (i % 8)) == 0 {
            0
        } else {
            255
        }
    }));
    Ok(RemovalMask {
        source_width,
        source_height,
        x,
        y,
        width,
        height,
        pixels,
    })
}

fn record_len(n: usize) -> Result<usize, String> {
    n.checked_add(7)
        .map(|n| n / 8)
        .and_then(|body| body.checked_add(HEADER_LEN))
        .ok_or_else(|| "removal mask: size overflow".to_string())
}

#[cfg(test)]
#[path = "removal_mask_store_tests.rs"]
mod tests;
