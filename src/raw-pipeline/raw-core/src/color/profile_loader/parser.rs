//! Binary-bundle parser for the embedded Maple profiles blob.
//!
//! Reader for the format produced by `src/scripts/convert_dcps.py`.
//! Both reader (this file) and writer (the script) must move together —
//! `FORMAT_VERSION` is bumped on any layout change.
//!
//! Returns an empty `HashMap` on any header validation failure (bad magic,
//! version mismatch, truncated buffer) so a stale or corrupted bundle
//! degrades to "no bundled profile available" instead of bricking the
//! crate. The bundle path itself is fixed at compile time via
//! [`include_bytes!`] in the parent module — see `super::PROFILES_BIN`.

use std::collections::HashMap;

use crate::color::hsm::{HsmEncoding, HsmTable};
use crate::color::illuminant::Illuminant as CoreIlluminant;
use crate::math::Matrix3;

use super::types::{CameraKey, MapleProfile};
use super::writer::EncoderProfile;
use super::{FORMAT_VERSION, MAGIC};

/// Extract every v1 record as a raw-byte [`EncoderProfile`] for lossless
/// transcode to v3 (#829). Unlike [`parse_bundle`] — which materializes
/// `HsmTable`s and `Matrix3`s — this copies the on-disk matrix and HSM bytes
/// verbatim, so a v1 → v3 repack does no float round-trip and the resolved
/// profile data is byte-identical. Returns `None` on a header/version
/// mismatch (not a v1 bundle) or a truncated/corrupt record.
pub(super) fn extract_v1_records(bytes: &[u8]) -> Option<Vec<EncoderProfile>> {
    if bytes.len() < 16 || &bytes[..4] != MAGIC {
        return None;
    }
    if u16::from_le_bytes([bytes[4], bytes[5]]) != FORMAT_VERSION {
        return None;
    }
    let count = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    let mut r = RawReader {
        buf: bytes,
        pos: 16,
    };
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        out.push(r.read_raw_record()?);
    }
    Some(out)
}

/// Minimal cursor over the v1 blob that yields raw record bytes (no float
/// decode). Separate from the `Reader` below so the materializing path stays
/// untouched.
struct RawReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> RawReader<'a> {
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
    fn read_u16(&mut self) -> Option<u16> {
        let b = self.take(2)?;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }

    /// Inverse of the v1 record layout (see [`Reader::read_profile`]): ucm,
    /// flags + reserved, illum1/illum2 + reserved, present matrices (36 B
    /// each), the HSM (dims+enc preamble then inline table bytes), then the
    /// 4-byte baseline-exposure offset.
    fn read_raw_record(&mut self) -> Option<EncoderProfile> {
        let ucm_len = self.read_u16()? as usize;
        let ucm_bytes = self.take(ucm_len)?.to_vec();
        let flags = self.take(1)?[0];
        let _reserved = self.take(1)?;
        let illum1 = self.read_u16()?;
        let illum2 = self.read_u16()?;
        let _reserved = self.read_u16()?;

        let nmat = (flags & 0x0F).count_ones() as usize;
        let matrices = self.take(nmat * 36)?.to_vec();

        let hsm_h = self.read_u16()?;
        let hsm_s = self.read_u16()?;
        let hsm_v = self.read_u16()?;
        let hsm_encoding = self.take(1)?[0];
        let _reserved = self.take(1)?;
        let table_bytes = (hsm_h as usize) * (hsm_s as usize) * (hsm_v as usize) * 3 * 4;
        let hsm1 = if flags & 0x10 != 0 {
            Some(self.take(table_bytes)?.to_vec())
        } else {
            None
        };
        let hsm2 = if flags & 0x20 != 0 {
            Some(self.take(table_bytes)?.to_vec())
        } else {
            None
        };

        let be = self.take(4)?;
        let be_bits = u32::from_le_bytes([be[0], be[1], be[2], be[3]]);

        Some(EncoderProfile {
            ucm_bytes,
            flags,
            illum1,
            illum2,
            matrices,
            hsm_dims: [hsm_h, hsm_s, hsm_v],
            hsm_encoding,
            hsm1,
            hsm2,
            be_bits,
        })
    }
}

/// Parse the embedded profiles blob into a lookup table keyed by UCM.
///
/// Graceful-degradation contract: any failure (bad header, malformed
/// record mid-bundle, truncated buffer) returns the entries that were
/// successfully read so far. Header-level failures return an empty map.
/// Duplicate UCMs are first-write-wins and surfaced via `eprintln!`.
pub(super) fn parse_bundle(bytes: &[u8]) -> HashMap<CameraKey, MapleProfile> {
    let mut map = HashMap::new();
    let mut r = match Reader::new(bytes) {
        Some(r) => r,
        None => return map, // empty / wrong-magic bundle → degrade to empty.
    };
    let count = r.count;
    let mut duplicates: Vec<String> = Vec::new();
    for _ in 0..count {
        let Some(profile) = r.read_profile() else {
            // Malformed record → bail with what we have so far. We don't
            // poison the whole table on a single bad record.
            break;
        };
        let key = CameraKey::new(profile.unique_camera_model.clone());
        // Deduplication is the converter's job (see
        // `src/scripts/convert_dcps.py`'s `dcp_preference` ranking,
        // which picks one record per UCM deterministically). If a duplicate
        // still slips through into the bundle we record it for the loader
        // tests below — the first-write wins so the converter's chosen
        // record is preserved instead of silently overwritten.
        if map.contains_key(&key) {
            duplicates.push(profile.unique_camera_model.clone());
            continue;
        }
        map.insert(key, profile);
    }
    if !duplicates.is_empty() {
        // Surface in test output / debug builds; production logging picks
        // this up via env_logger when wired in. Hard-failing in release
        // would brick the app on a slightly-stale bundle, so we degrade
        // gracefully with first-write-wins.
        eprintln!(
            "profile_loader: bundle contains {} duplicate-UCM record(s) \
             (first-write wins): {:?}",
            duplicates.len(),
            &duplicates[..duplicates.len().min(5)]
        );
    }
    map
}

pub(super) struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    pub(super) count: u32,
}

impl<'a> Reader<'a> {
    pub(super) fn new(buf: &'a [u8]) -> Option<Self> {
        if buf.len() < 16 || &buf[..4] != MAGIC {
            return None;
        }
        let version = u16::from_le_bytes([buf[4], buf[5]]);
        if version != FORMAT_VERSION {
            return None;
        }
        let count = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
        Some(Self {
            buf,
            pos: 16,
            count,
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
    fn read_f32(&mut self) -> Option<f32> {
        let b = self.take(4)?;
        Some(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn read_matrix(&mut self) -> Option<Matrix3> {
        let mut m = [[0f32; 3]; 3];
        for r in 0..3 {
            for c in 0..3 {
                m[r][c] = self.read_f32()?;
            }
        }
        Some(Matrix3(m))
    }

    fn read_hsm(&mut self, dims: [u32; 3], encoding: HsmEncoding) -> Option<HsmTable> {
        let expected = (dims[0] as usize) * (dims[1] as usize) * (dims[2] as usize) * 3;
        let mut data = Vec::with_capacity(expected);
        for _ in 0..expected {
            data.push(self.read_f32()?);
        }
        HsmTable::new(dims, data, encoding)
    }

    pub(super) fn read_profile(&mut self) -> Option<MapleProfile> {
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

        let hsm_h = self.read_u16()? as u32;
        let hsm_s = self.read_u16()? as u32;
        let hsm_v = self.read_u16()? as u32;
        let hsm_encoding_byte = self.read_u8()?;
        let _reserved = self.read_u8()?;
        let hsm_encoding = match hsm_encoding_byte {
            1 => HsmEncoding::Srgb,
            _ => HsmEncoding::Linear,
        };

        let hsm1 = if flags & 0x10 != 0 {
            self.read_hsm([hsm_h, hsm_s, hsm_v], hsm_encoding)
        } else {
            None
        };
        let hsm2 = if flags & 0x20 != 0 {
            self.read_hsm([hsm_h, hsm_s, hsm_v], hsm_encoding)
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

        Some(MapleProfile {
            unique_camera_model,
            illum1,
            illum2,
            cm1,
            cm2,
            fm1,
            fm2,
            hsm1,
            hsm2,
            baseline_exposure_offset,
        })
    }
}

/// Same EXIF-illuminant decoder as `decode.rs::exif_illuminant_to_core`,
/// duplicated to keep the loader self-contained. The DNG/EXIF tags are
/// stable; if the mapping ever changes both call sites must move together.
fn exif_illuminant_to_core(code: u16) -> CoreIlluminant {
    match code {
        17 => CoreIlluminant::StdA,
        21 => CoreIlluminant::D65,
        22 => CoreIlluminant::D55,
        23 => CoreIlluminant::D50,
        _ => CoreIlluminant::D65,
    }
}

#[cfg(test)]
mod tests {
    use super::super::PROFILES_BIN;
    use super::*;

    /// The shipped bundle has no duplicate UCMs. The converter
    /// (`src/scripts/convert_dcps.py`) deterministically picks one
    /// record per UCM via `dcp_preference`; this test catches a regression
    /// where the dedup step is bypassed or a converter rewrite re-introduces
    /// duplicates (which would silently overwrite records in `parse_bundle`
    /// pre-PR #330-followup; today the loader detects them but still drops
    /// data — neither is desirable).
    #[test]
    fn shipped_bundle_has_no_duplicate_ucms() {
        // profiles.bin is COMMITTED and `include_bytes!`-embedded (the crate
        // would not even compile without it), so an unreadable bundle is a
        // corrupt artifact — fail loudly rather than skip-pass (#1082).
        let mut r = Reader::new(PROFILES_BIN)
            .expect("embedded profiles.bin failed header validation — corrupt bundle");
        let mut seen = std::collections::HashSet::new();
        let mut dupes: Vec<String> = Vec::new();
        for _ in 0..r.count {
            let Some(p) = r.read_profile() else { break };
            if !seen.insert(p.unique_camera_model.clone()) {
                dupes.push(p.unique_camera_model);
            }
        }
        assert!(
            dupes.is_empty(),
            "shipped profiles.bin contains {} duplicate-UCM record(s): {:?}",
            dupes.len(),
            dupes
        );
    }

    /// Header validation: a buffer that doesn't start with `MDCP` produces an
    /// empty bundle without panicking.
    #[test]
    fn bad_magic_yields_empty_bundle() {
        // Simulate a bundle parse on a known-bad buffer via a private path.
        let bad = b"NOTOK\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00";
        assert!(Reader::new(bad).is_none());
    }

    /// Header validation: version mismatch yields no Reader.
    #[test]
    fn version_mismatch_yields_empty_bundle() {
        let mut buf = Vec::new();
        buf.extend_from_slice(MAGIC);
        buf.extend_from_slice(&999u16.to_le_bytes()); // wrong version
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        assert!(Reader::new(&buf).is_none());
    }
}
