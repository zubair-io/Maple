//! Seekable AVIF probe: validate the container with avif-parse, then read
//! sequence-header OBUs from the primary item's logical extent stream (#3620).

use super::{err, panicked, probe_sequence, AvifProbe};
use crate::metadata_source::{MetadataSource, SeekableSource};
use std::borrow::Cow;
use std::io::{Read, Seek};
use std::ops::Range;
use std::panic::{catch_unwind, AssertUnwindSafe};

pub fn probe_avif_reader<R: Read + Seek>(reader: &mut R) -> crate::error::Result<AvifProbe> {
    let layout = catch_unwind(AssertUnwindSafe(|| avif_parse::read_avif_layout(reader)))
        .map_err(|p| panicked("avif container parse panicked (corrupt stream)", p))?
        .map_err(|e| err(format!("avif container: {e}")))?;
    let source = SeekableSource::new(reader).map_err(|e| err(format!("avif container: {e}")))?;
    let item = ItemSource::new(&source, &layout.primary_extents)?;
    let headers = sequence_obus(&item);
    let headers = source
        .finish(headers)
        .map_err(|e| err(format!("avif container: {e}")))??;
    probe_sequence(&headers, layout.has_alpha)
}

struct ItemSource<'a, S: ?Sized> {
    source: &'a S,
    extents: &'a [Range<u64>],
    length: usize,
}

impl<'a, S: MetadataSource + ?Sized> ItemSource<'a, S> {
    fn new(source: &'a S, extents: &'a [Range<u64>]) -> crate::error::Result<Self> {
        let length = extents
            .iter()
            .try_fold(0usize, |length, extent| {
                length.checked_add(usize::try_from(extent.end - extent.start).ok()?)
            })
            .ok_or_else(|| err("avif container: integer conversion failed"))?;
        Ok(Self {
            source,
            extents,
            length,
        })
    }
}

impl<S: MetadataSource + ?Sized> MetadataSource for ItemSource<'_, S> {
    fn len(&self) -> usize {
        self.length
    }

    fn get(&self, range: Range<usize>) -> Option<Cow<'_, [u8]>> {
        if !self.contains(range.clone()) {
            return None;
        }
        let mut out = Vec::new();
        out.try_reserve_exact(range.len()).ok()?;
        let mut logical = 0usize;
        for extent in self.extents {
            let length = usize::try_from(extent.end - extent.start).ok()?;
            let start = range.start.max(logical);
            let end = range.end.min(logical + length);
            if start < end {
                let base = usize::try_from(extent.start).ok()?;
                let file_start = base.checked_add(start.checked_sub(logical)?)?;
                let file_end = base.checked_add(end.checked_sub(logical)?)?;
                let bytes = self.source.get(file_start..file_end)?;
                out.extend_from_slice(&bytes);
            }
            logical += length;
            if logical >= range.end {
                break;
            }
        }
        Some(Cow::Owned(out))
    }
}

fn invalid_obu() -> crate::error::Error {
    err(format!(
        "avif sequence header parse failed (dav1d rc {})",
        -libc::EINVAL
    ))
}

fn header_byte(item: &impl MetadataSource, at: usize, start: usize) -> crate::error::Result<u8> {
    item.byte(at).ok_or_else(|| {
        // Let the existing rav1d barrier classify a truncated OBU header,
        // including its debug-build panic diagnostic. Such a tail is at
        // most ten bytes, so this never buffers a frame payload.
        if item.len() - start > 10 {
            return invalid_obu();
        }
        let tail = item.get(start..item.len()).unwrap_or_default();
        probe_sequence(&tail, false)
            .err()
            .unwrap_or_else(invalid_obu)
    })
}

fn sequence_obus(item: &impl MetadataSource) -> crate::error::Result<Vec<u8>> {
    if item.len() == 0 {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < item.len() {
        let start = at;
        let header = header_byte(item, at, start)?;
        at += 1;
        if header & 4 != 0 {
            header_byte(item, at, start)?;
            at += 1;
        }
        let length = if header & 2 != 0 {
            // dav1d's get_uleb128 accepts at most eight bytes and u32::MAX.
            let mut value = 0u64;
            let mut complete = false;
            for shift in (0..56).step_by(7) {
                let byte = header_byte(item, at, start)?;
                at += 1;
                value |= u64::from(byte & 127) << shift;
                if byte & 128 == 0 {
                    complete = true;
                    break;
                }
            }
            if !complete || value > u64::from(u32::MAX) {
                return Err(invalid_obu());
            }
            usize::try_from(value).map_err(|_| invalid_obu())?
        } else {
            item.len().checked_sub(at).ok_or_else(invalid_obu)?
        };
        let end = at
            .checked_add(length)
            .filter(|&end| end <= item.len())
            .ok_or_else(invalid_obu)?;
        if (header >> 3) & 15 == 1 {
            let bytes = item.get(start..end).ok_or_else(invalid_obu)?;
            out.try_reserve(bytes.len())
                .map_err(|e| err(format!("avif container: {e}")))?;
            out.extend_from_slice(&bytes);
        }
        at = end;
    }
    // Preserve dav1d's 'no sequence header' result for a nonempty item.
    if out.is_empty() {
        out.extend_from_slice(&[0x12, 0]);
    }
    Ok(out)
}
