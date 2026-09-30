// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. See LICENSE. Maple seekable metadata patch (#3620).

use super::*;
use std::io::{Seek, SeekFrom};

/// Validated file extents for the primary AV1 item, without copying media data.
/// This is a metadata probe layout, not input to an AV1 pixel decoder.
pub struct AvifLayout {
    pub primary_extents: TryVec<Range<u64>>,
    pub has_alpha: bool,
}

/// Parse the same container grammar as `read_avif`, seeking over media data.
/// All primary and alpha extents are validated, including disjoint extents,
/// 64-bit box sizes, and iloc v2. The caller reads the primary AV1 headers.
pub fn read_avif_layout<T: Read + Seek>(f: &mut T) -> Result<AvifLayout> {
    let length = f.seek(SeekFrom::End(0))?;
    f.seek(SeekFrom::Start(0))?;
    let mut mdats = TryVec::<Range<u64>>::new();
    let meta = read_avif_container(f, |b| {
        let start = b.offset();
        let end = start
            .checked_add(b.bytes_left())
            .ok_or(Error::InvalidData("extent end overflow"))?;
        if b.head.name == BoxType::MediaDataBox && end > start {
            mdats.push(start..end)?;
        }
        let src = b.content.get_mut();
        let actual_end = end.min(length);
        src.reader.seek(SeekFrom::Start(actual_end))?;
        src.offset = actual_end;
        // Preserve read_avif's parser-state error on a truncated body.
        b.content.set_limit(end - actual_end);
        Ok(())
    })?;
    let alpha_id = alpha_item_id(&meta);
    let mut primary = TryVec::new();
    let mut has_alpha = false;
    let mut primary_length = 0u64;
    let mut alpha_length = 0u64;
    for loc in &meta.iloc_items {
        let item_length = if loc.item_id == meta.primary_item_id {
            &mut primary_length
        } else if Some(loc.item_id) == alpha_id {
            has_alpha = true;
            &mut alpha_length
        } else {
            continue;
        };
        if loc.construction_method != ConstructionMethod::File {
            return Err(Error::Unsupported("unsupported construction_method"));
        }
        for extent in &loc.extents {
            let start = extent.extent_range.start();
            let mdat = mdats
                .iter_mut()
                .find(|mdat| {
                    // Match read_avif's take-whole-box optimization, including
                    // its consumption of that box before subsequent extents.
                    let matches = mdat.start == start
                        && match &extent.extent_range {
                            ExtentRange::WithLength(range) => range.end == mdat.end,
                            ExtentRange::ToEnd(_) => true,
                        };
                    (*item_length == 0 && matches) || (start >= mdat.start && start < mdat.end)
                })
                .ok_or(Error::InvalidData(
                    "iloc contains an extent that is not in mdat",
                ))?;
            let end = match &extent.extent_range {
                ExtentRange::WithLength(range) => range.end,
                ExtentRange::ToEnd(_) => mdat.end,
            };
            if end < start {
                return Err(Error::InvalidData("range start > end"));
            }
            if end > mdat.end {
                return Err(Error::InvalidData("extent crosses box boundary"));
            }
            if loc.item_id == meta.primary_item_id {
                primary.push(start..end)?;
            }
            if *item_length == 0 && start == mdat.start && end == mdat.end {
                mdat.end = mdat.start;
            }
            *item_length = item_length
                .checked_add(end - start)
                .ok_or(Error::InvalidData("extent end overflow"))?;
        }
    }
    Ok(AvifLayout {
        primary_extents: primary,
        has_alpha,
    })
}
