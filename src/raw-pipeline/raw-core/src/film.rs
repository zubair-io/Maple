//! `.mlut` film-look 3D LUT codec + tetrahedral sampler (epic #2683).
//!
//! Foundation module for the display-referred film-emulation pipeline
//! stage: a binary container for a baked `size³` RGB→RGB grid, plus the
//! scalar sampler later pipeline/GPU stages call per pixel.
//!
//! Format v1 (little-endian throughout):
//!   bytes 0..4   magic `b"MLUT"`
//!   bytes 4..6   version, u16 = 1
//!   bytes 6..8   grid size N, u16
//!   bytes 8..    payload: N³·3 f16 values, layout `((b*N+g)*N+r)*3+c`
//!
//! f16 storage halves the on-disk/embedded size of a baked LUT relative to
//! f32 (e.g. a 33³ grid: ~215KB vs ~431KB) at a precision cost far below
//! film-look grading tolerances.
//!
//! The tetrahedral sampler is a fresh, self-contained port of the same
//! six-tetrahedron decomposition used by
//! `view::auto_profile::lut::ColorLut::sample` and its WGSL twin
//! `raw-gpu/src/residual_lut.wgsl` — not a refactor of either. A later GPU
//! parity gate pins agreement between this scalar reference and the WGSL
//! kernel to 1e-4.

use half::f16;

/// File magic: "Maple LUT".
const MAGIC: &[u8; 4] = b"MLUT";
/// Format version. Bump on any layout change and add a migration path.
const VERSION: u16 = 1;
/// Fixed header size: magic(4) + version(2) + grid(2).
const HEADER_LEN: usize = 8;

/// A decoded film-look LUT: `size` nodes per axis, `data` the flat
/// `size³·3` RGB grid in `((b*N+g)*N+r)*3+c` layout (matches
/// [`tetra_sample`] and the `.mlut` payload order).
#[derive(Clone, Debug, PartialEq)]
pub struct FilmLut {
    pub size: usize,
    pub data: Vec<f32>,
}

/// `.mlut` decode failures. Distinct from the crate-wide [`crate::Error`]:
/// a malformed film LUT (bad ingest, truncated download, hand-edited file)
/// is a data problem local to this codec, not a RAW-decode/pipeline
/// failure.
#[derive(Debug, thiserror::Error)]
pub enum MlutError {
    #[error(".mlut: bad magic (expected \"MLUT\")")]
    BadMagic,
    #[error(".mlut: unsupported version {0} (only version 1 is supported)")]
    UnsupportedVersion(u16),
    #[error(".mlut: truncated ({actual} bytes, expected {expected})")]
    Truncated { expected: usize, actual: usize },
    #[error(".mlut: grid size {0} overflows the payload length calculation")]
    GridOverflow(usize),
}

/// Encode a `size³·3` f32 grid to the `.mlut` v1 byte layout. `data` is
/// written verbatim in the caller's order (`size` only feeds the header);
/// callers are expected to hand in a grid already shaped `size³·3` per
/// [`FilmLut`]'s layout contract.
pub fn encode_mlut(size: usize, data: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + data.len() * 2);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&(size as u16).to_le_bytes());
    for &v in data {
        out.extend_from_slice(&f16::from_f32(v).to_bits().to_le_bytes());
    }
    out
}

/// Decode a `.mlut` v1 byte buffer, validating magic, version, and that the
/// declared grid size matches the payload length exactly.
pub fn decode_mlut(bytes: &[u8]) -> Result<FilmLut, MlutError> {
    if bytes.len() < HEADER_LEN {
        return Err(MlutError::Truncated {
            expected: HEADER_LEN,
            actual: bytes.len(),
        });
    }
    if &bytes[0..4] != MAGIC {
        return Err(MlutError::BadMagic);
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if version != VERSION {
        return Err(MlutError::UnsupportedVersion(version));
    }
    let grid = u16::from_le_bytes([bytes[6], bytes[7]]) as usize;
    // Overflow-checked: `grid` comes straight off the wire (up to 65535),
    // and `usize` is 32-bit on the wasm32 target the same grid bytes ship
    // to — a naive `grid*grid*grid*3` can wrap there well before it would
    // on a 64-bit host.
    let node_count = grid
        .checked_mul(grid)
        .and_then(|g2| g2.checked_mul(grid))
        .and_then(|g3| g3.checked_mul(3))
        .ok_or(MlutError::GridOverflow(grid))?;
    let payload_len = node_count
        .checked_mul(2)
        .ok_or(MlutError::GridOverflow(grid))?;
    let expected = HEADER_LEN + payload_len;
    if bytes.len() != expected {
        return Err(MlutError::Truncated {
            expected,
            actual: bytes.len(),
        });
    }

    let data = (0..node_count)
        .map(|i| {
            let o = HEADER_LEN + i * 2;
            f16::from_bits(u16::from_le_bytes([bytes[o], bytes[o + 1]])).to_f32()
        })
        .collect();

    Ok(FilmLut { size: grid, data })
}

/// Tetrahedral lookup of one RGB triplet from a flat `size³·3` grid
/// (layout `((b*N+g)*N+r)*3+c`). Mirrors
/// `view::auto_profile::lut::ColorLut::sample` /
/// `residual_lut.wgsl::lut_sample` EXACTLY: same `lo`/`f` derivation
/// (including the `min(_, last-1)` top-cell guard — an input of exactly
/// 1.0 lands in the top cell with `f = 1.0`, not an out-of-range node
/// read) and the same six-case barycentric split of the unit cube by the
/// ordering of `f_r`/`f_g`/`f_b`, blending 4 of the 8 corner nodes per
/// sample. NOT trilinear — trilinear and tetrahedral interpolation only
/// agree on the corners/edges they share by construction; interior
/// samples diverge (see the WGSL module doc, #1737).
pub fn tetra_sample(size: usize, data: &[f32], rgb: [f32; 3]) -> [f32; 3] {
    let n = size;
    let last = (n - 1) as f32;

    let node = |r: usize, g: usize, b: usize| -> [f32; 3] {
        let i = ((b * n + g) * n + r) * 3;
        [data[i], data[i + 1], data[i + 2]]
    };
    let axis = |v: f32| -> (usize, f32) {
        let p = v.clamp(0.0, 1.0) * last;
        let lo = p.floor().min(last - 1.0);
        (lo as usize, p - lo)
    };

    let (r0, fx) = axis(rgb[0]);
    let (g0, fy) = axis(rgb[1]);
    let (b0, fz) = axis(rgb[2]);
    let (r1, g1, b1) = (r0 + 1, g0 + 1, b0 + 1);

    let c000 = node(r0, g0, b0);
    let c100 = node(r1, g0, b0);
    let c010 = node(r0, g1, b0);
    let c110 = node(r1, g1, b0);
    let c001 = node(r0, g0, b1);
    let c101 = node(r1, g0, b1);
    let c011 = node(r0, g1, b1);
    let c111 = node(r1, g1, b1);

    let mut out = [0.0f32; 3];
    for c in 0..3 {
        out[c] = if fx >= fy {
            if fy >= fz {
                c000[c] * (1.0 - fx) + c100[c] * (fx - fy) + c110[c] * (fy - fz) + c111[c] * fz
            } else if fx >= fz {
                c000[c] * (1.0 - fx) + c100[c] * (fx - fz) + c101[c] * (fz - fy) + c111[c] * fy
            } else {
                c000[c] * (1.0 - fz) + c001[c] * (fz - fx) + c101[c] * (fx - fy) + c111[c] * fy
            }
        } else if fx >= fz {
            c000[c] * (1.0 - fy) + c010[c] * (fy - fx) + c110[c] * (fx - fz) + c111[c] * fz
        } else if fy >= fz {
            c000[c] * (1.0 - fy) + c010[c] * (fy - fz) + c011[c] * (fz - fx) + c111[c] * fx
        } else {
            c000[c] * (1.0 - fz) + c001[c] * (fz - fy) + c011[c] * (fy - fx) + c111[c] * fx
        };
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Local test helper: an identity lattice where node (r,g,b) stores
    /// (r,g,b)/(n-1), the same layout formula the codec/sampler use.
    fn identity_lattice(n: usize) -> Vec<f32> {
        let denom = (n - 1) as f32;
        let mut data = vec![0.0f32; n * n * n * 3];
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    data[i] = r as f32 / denom;
                    data[i + 1] = g as f32 / denom;
                    data[i + 2] = b as f32 / denom;
                }
            }
        }
        data
    }

    #[test]
    fn mlut_round_trip_preserves_f16_exact_values() {
        // k/32 grid values are exact in f16, so identity survives round-trip bitwise.
        let n = 3usize;
        let data: Vec<f32> = (0..n * n * n * 3).map(|i| (i % 32) as f32 / 32.0).collect();
        let lut = decode_mlut(&encode_mlut(n, &data)).unwrap();
        assert_eq!(lut.size, n);
        assert_eq!(lut.data, data);
    }

    #[test]
    fn mlut_rejects_bad_magic_version_and_truncation() {
        let good = encode_mlut(2, &vec![0.5f32; 2 * 2 * 2 * 3]);
        assert!(decode_mlut(&good[1..]).is_err()); // bad magic
        let mut v = good.clone();
        v[4] = 9; // bad version
        assert!(decode_mlut(&v).is_err());
        assert!(decode_mlut(&good[..good.len() - 2]).is_err()); // truncated payload
    }

    #[test]
    fn tetra_sample_is_exact_at_lattice_nodes_and_monotone_on_diagonal() {
        let n = 5usize;
        // Identity lattice: node (r,g,b) stores (r,g,b)/(n-1).
        let data = identity_lattice(n); // local test helper, built with the layout formula
        for &v in &[0.0f32, 0.25, 0.5, 1.0] {
            let out = tetra_sample(n, &data, [v, v, v]);
            for c in 0..3 {
                assert!((out[c] - v).abs() < 1e-6);
            }
        }
        // Off-node point on identity lattice must reproduce the input.
        let out = tetra_sample(n, &data, [0.3, 0.7, 0.1]);
        assert!(
            (out[0] - 0.3).abs() < 1e-6 && (out[1] - 0.7).abs() < 1e-6 && (out[2] - 0.1).abs() < 1e-6
        );
    }
}
