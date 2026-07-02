//! Reader for the **v3 split** DCP-bundle layout (ticket #829, design PR #831).
//!
//! Mirror of [`super::writer`]; the two must move together. The v3 layout is
//! deliberately *delivery-agnostic*: every entry point here operates on a byte
//! slice with explicit offsets, so #828 can layer async range-fetch +
//! IndexedDB on top without re-churning the format. There is no I/O and no
//! awaiting here — just slice arithmetic + per-entry inflate.
//!
//! Two access paths, by design:
//!
//!   * [`parse_index`] — reads ONLY the index region (header + pool directory +
//!     records) from a slice. It never touches the pool region, which is the
//!     structural proof of correction #1 (index hoisted out of the compressed
//!     part): a body's matrices + HSM pool-index refs resolve without inflating
//!     any HSM. Returns a [`ProfileIndex`].
//!   * [`inflate_pool_entry`] — given the pool region bytes (or just the byte
//!     range for one entry) and a [`PoolDirEntry`], inflates that single zlib
//!     stream into an [`HsmTable`]. One body's entries inflate in isolation
//!     (correction #3); the directory gives the exact range (correction #2).
//!
//! See the v3 byte spec in [`super::writer`].

use crate::color::hsm::{HsmEncoding, HsmTable};
use crate::color::illuminant::Illuminant as CoreIlluminant;
use crate::math::Matrix3;

use super::types::{CameraKey, IndexRecord, PoolDirEntry, ProfileIndex};
use super::{FORMAT_VERSION_V3, MAGIC};

/// Parse the v3 **index region** from `idx` — header, pool offset directory,
/// and all profile records. Touches none of the pool region.
///
/// Graceful-degradation: any header/record failure returns the records read so
/// far (header failure → empty), matching the v1 parser's contract.
pub fn parse_index(idx: &[u8]) -> ProfileIndex {
    let mut out = ProfileIndex::default();
    let mut r = match V3Reader::new(idx) {
        Some(r) => r,
        None => return out,
    };
    // Pool directory first (fixed-size entries up front).
    let pool_dir = match r.read_pool_directory() {
        Some(d) => d,
        None => return out,
    };
    out.pool_dir = pool_dir;
    // Then the variable-length records.
    for _ in 0..r.num_profiles {
        let Some(rec) = r.read_record() else {
            break;
        };
        let key = CameraKey::new(rec.unique_camera_model.clone());
        out.records.entry(key).or_insert(rec);
    }
    out
}

/// Inflate one pool entry into an [`HsmTable`]. `entry_bytes` is the zlib
/// stream for exactly this entry — `pool[dir.offset .. dir.offset+compressed_len]`
/// — so a delivery layer can hand over either the whole pool sliced at the
/// directory range or a range-fetched buffer; only the entry's own bytes are
/// inflated. Returns `None` on inflate failure or a dims/length mismatch.
pub fn inflate_pool_entry(entry_bytes: &[u8], dir: &PoolDirEntry) -> Option<HsmTable> {
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib(entry_bytes).ok()?;
    let expected_f32 = (dir.dims[0] as usize) * (dir.dims[1] as usize) * (dir.dims[2] as usize) * 3;
    if raw.len() != expected_f32 * 4 {
        return None;
    }
    let mut data = Vec::with_capacity(expected_f32);
    for chunk in raw.chunks_exact(4) {
        data.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    HsmTable::new(dir.dims, data, dir.encoding)
}

/// Resolve a single pool entry from the full pool region, slicing at the
/// directory range then inflating. Convenience wrapper over
/// [`inflate_pool_entry`] for the embedded (whole-pool-resident) path.
pub fn resolve_from_pool(pool_region: &[u8], index: u32, dir: &[PoolDirEntry]) -> Option<HsmTable> {
    let entry = dir.get(index as usize)?;
    let start = entry.offset as usize;
    let end = start.checked_add(entry.compressed_len as usize)?;
    let bytes = pool_region.get(start..end)?;
    inflate_pool_entry(bytes, entry)
}

struct V3Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    num_profiles: u32,
    pool_count: u32,
}

impl<'a> V3Reader<'a> {
    fn new(buf: &'a [u8]) -> Option<Self> {
        if buf.len() < 16 || &buf[..4] != MAGIC {
            return None;
        }
        let version = u16::from_le_bytes([buf[4], buf[5]]);
        if version != FORMAT_VERSION_V3 {
            return None;
        }
        let num_profiles = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        let pool_count = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
        Some(Self {
            buf,
            pos: 16,
            num_profiles,
            pool_count,
        })
    }

    #[inline]
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        if end > self.buf.len() {
            return None;
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Some(s)
    }

    fn read_u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn read_u16(&mut self) -> Option<u16> {
        let b = self.take(2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }
    fn read_u32(&mut self) -> Option<u32> {
        let b = self.take(4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn read_f32(&mut self) -> Option<f32> {
        let b = self.take(4)?;
        Some(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_matrix(&mut self) -> Option<Matrix3> {
        let mut m = [[0f32; 3]; 3];
        for row in m.iter_mut() {
            for c in row.iter_mut() {
                *c = self.read_f32()?;
            }
        }
        Some(Matrix3(m))
    }

    /// Read the `pool_count` fixed-size (16-byte) directory entries.
    fn read_pool_directory(&mut self) -> Option<Vec<PoolDirEntry>> {
        // Guard a corrupt count against driving a huge allocation: each entry
        // is 16 bytes and must fit in the remaining buffer.
        if (self.pool_count as usize).checked_mul(16)? > self.buf.len() {
            return None;
        }
        let mut dir = Vec::with_capacity(self.pool_count as usize);
        for _ in 0..self.pool_count {
            let offset = self.read_u32()?;
            let compressed_len = self.read_u32()?;
            let h = self.read_u16()? as u32;
            let s = self.read_u16()? as u32;
            let v = self.read_u16()? as u32;
            let enc_byte = self.read_u8()?;
            let _reserved = self.read_u8()?;
            let encoding = match enc_byte {
                1 => HsmEncoding::Srgb,
                _ => HsmEncoding::Linear,
            };
            dir.push(PoolDirEntry {
                offset,
                compressed_len,
                dims: [h, s, v],
                encoding,
            });
        }
        Some(dir)
    }

    fn read_record(&mut self) -> Option<IndexRecord> {
        let ucm_len = self.read_u16()? as usize;
        let ucm_bytes = self.take(ucm_len)?;
        let unique_camera_model = std::str::from_utf8(ucm_bytes).ok()?.to_string();

        let flags = self.read_u8()?;
        let _reserved = self.read_u8()?;
        let illum1_code = self.read_u16()?;
        let illum2_code = self.read_u16()?;
        let _reserved = self.read_u16()?;

        let cm1 = if flags & 0x01 != 0 {
            Some(self.read_matrix()?)
        } else {
            None
        };
        let cm2 = if flags & 0x02 != 0 {
            Some(self.read_matrix()?)
        } else {
            None
        };
        let fm1 = if flags & 0x04 != 0 {
            Some(self.read_matrix()?)
        } else {
            None
        };
        let fm2 = if flags & 0x08 != 0 {
            Some(self.read_matrix()?)
        } else {
            None
        };

        let hsm1_pool_index = if flags & 0x10 != 0 {
            Some(self.read_u32()?)
        } else {
            None
        };
        let hsm2_pool_index = if flags & 0x20 != 0 {
            Some(self.read_u32()?)
        } else {
            None
        };

        let baseline_exposure_offset = self.read_f32()?;

        let illum1 = if illum1_code != 0 {
            Some(exif_illuminant_to_core(illum1_code))
        } else {
            None
        };
        let illum2 = if illum2_code != 0 {
            Some(exif_illuminant_to_core(illum2_code))
        } else {
            None
        };

        Some(IndexRecord {
            unique_camera_model,
            illum1,
            illum2,
            cm1,
            cm2,
            fm1,
            fm2,
            hsm1_pool_index,
            hsm2_pool_index,
            baseline_exposure_offset,
        })
    }
}

/// Same EXIF-illuminant decoder as the v1 parser; the DNG/EXIF tags are stable.
fn exif_illuminant_to_core(code: u16) -> CoreIlluminant {
    match code {
        17 => CoreIlluminant::StdA,
        21 => CoreIlluminant::D65,
        22 => CoreIlluminant::D55,
        23 => CoreIlluminant::D50,
        _ => CoreIlluminant::D65,
    }
}
