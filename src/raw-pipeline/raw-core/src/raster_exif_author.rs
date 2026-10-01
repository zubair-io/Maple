//! Sharp-style IFD tag objects, authored without a native metadata dependency (#3588).
//! Merge appends replacement directories to an unchanged copy of the source TIFF
//! block. Existing opaque payloads, MakerNote offsets and thumbnail bytes stay put.

use crate::{error::Result, raster_recipe::bad};
use std::collections::{BTreeMap, BTreeSet};

#[path = "raster_exif_values.rs"]
mod values;

pub type ExifTags = BTreeMap<String, BTreeMap<String, String>>;

#[derive(Clone, Copy)]
pub(super) struct ByteOrder(pub bool);

impl ByteOrder {
    pub(super) fn u16(self, value: u16) -> [u8; 2] {
        if self.0 {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        }
    }
    pub(super) fn u32(self, value: u32) -> [u8; 4] {
        if self.0 {
            value.to_le_bytes()
        } else {
            value.to_be_bytes()
        }
    }
    fn read16(self, bytes: &[u8]) -> u16 {
        if self.0 {
            u16::from_le_bytes(bytes.try_into().unwrap())
        } else {
            u16::from_be_bytes(bytes.try_into().unwrap())
        }
    }
    fn read32(self, bytes: &[u8]) -> u32 {
        if self.0 {
            u32::from_le_bytes(bytes.try_into().unwrap())
        } else {
            u32::from_be_bytes(bytes.try_into().unwrap())
        }
    }
}

#[derive(Clone)]
struct Entry {
    format: u16,
    count: u32,
    value: [u8; 4],
}

type Directory = BTreeMap<u16, Entry>;

fn malformed() -> crate::error::Error {
    bad("metadata.exifTags: malformed source EXIF directory".into())
}

fn ifd_number(name: &str) -> Result<usize> {
    match name.to_ascii_lowercase().as_str() {
        "ifd0" => Ok(0),
        "ifd1" => Ok(1),
        "ifd2" => Ok(2),
        "ifd3" => Ok(3),
        "ifd4" => Ok(4),
        _ => Err(bad(format!("metadata.exifTags: unknown IFD {name}"))),
    }
}

fn read_ifd(bytes: &[u8], order: ByteOrder, offset: u32) -> Result<(Directory, u32)> {
    if offset == 0 {
        return Ok((Directory::new(), 0));
    }
    let at = usize::try_from(offset).map_err(|_| malformed())?;
    let count = order.read16(
        bytes
            .get(at..at.checked_add(2).ok_or_else(malformed)?)
            .ok_or_else(malformed)?,
    ) as usize;
    let start = at.checked_add(2).ok_or_else(malformed)?;
    let end = start
        .checked_add(count.checked_mul(12).ok_or_else(malformed)?)
        .ok_or_else(malformed)?;
    let entries = bytes.get(start..end).ok_or_else(malformed)?;
    let next = order.read32(
        bytes
            .get(end..end.checked_add(4).ok_or_else(malformed)?)
            .ok_or_else(malformed)?,
    );
    let mut directory = Directory::new();
    for raw in entries.chunks_exact(12) {
        let tag = order.read16(&raw[..2]);
        let format = order.read16(&raw[2..4]);
        let count = order.read32(&raw[4..8]);
        let value: [u8; 4] = raw[8..12].try_into().unwrap();
        let size = match format {
            1 | 2 | 6 | 7 => Some(1usize),
            3 | 8 => Some(2),
            4 | 9 | 11 | 13 => Some(4),
            5 | 10 | 12 => Some(8),
            _ => None, // An unknown type remains opaque; do not invent a payload size.
        };
        if let Some(size) = size {
            let length = size.checked_mul(count as usize).ok_or_else(malformed)?;
            if length > 4 {
                let value_at = order.read32(&value) as usize;
                bytes
                    .get(value_at..value_at.checked_add(length).ok_or_else(malformed)?)
                    .ok_or_else(malformed)?;
            }
        }
        if directory
            .insert(
                tag,
                Entry {
                    format,
                    count,
                    value,
                },
            )
            .is_some()
        {
            return Err(malformed());
        }
    }
    Ok((directory, next))
}

fn pointer(directory: &Directory, tag: u16, order: ByteOrder) -> Result<u32> {
    match directory.get(&tag) {
        None => Ok(0),
        Some(entry) if entry.format == 4 && entry.count == 1 => Ok(order.read32(&entry.value)),
        _ => Err(malformed()),
    }
}

fn read_directories(bytes: &[u8], order: ByteOrder) -> Result<([Directory; 5], [u32; 5])> {
    let root = order.read32(&bytes[4..8]);
    let (ifd0, next) = read_ifd(bytes, order, root)?;
    let exif = pointer(&ifd0, 0x8769, order)?;
    let gps = pointer(&ifd0, 0x8825, order)?;
    let (ifd2, exif_next) = read_ifd(bytes, order, exif)?;
    let interop = pointer(&ifd2, 0xa005, order)?;
    let offsets = [root, next, exif, gps, interop];
    let mut visited = BTreeSet::new();
    if offsets
        .into_iter()
        .filter(|offset| *offset != 0)
        .any(|offset| !visited.insert(offset))
    {
        return Err(malformed());
    }
    let (ifd1, thumbnail_next) = read_ifd(bytes, order, next)?;
    let (ifd3, gps_next) = read_ifd(bytes, order, gps)?;
    let (ifd4, interop_next) = read_ifd(bytes, order, interop)?;
    let tails = [0, thumbnail_next, exif_next, gps_next, interop_next];
    // Preserve foreign continuation directories, but reject cycles or dangling tails.
    for first in tails {
        let mut tail = first;
        let mut chain = visited.clone();
        while tail != 0 {
            if !chain.insert(tail) {
                return Err(malformed());
            }
            tail = read_ifd(bytes, order, tail)?.1;
        }
    }
    Ok(([ifd0, ifd1, ifd2, ifd3, ifd4], tails))
}

fn add_payload(
    bytes: &mut Vec<u8>,
    order: ByteOrder,
    format: u16,
    payload: Vec<u8>,
    count: u32,
) -> Result<Entry> {
    let value = if payload.len() <= 4 {
        let mut inline = [0; 4];
        inline[..payload.len()].copy_from_slice(&payload);
        inline
    } else {
        if bytes.len() % 2 != 0 {
            bytes.push(0);
        }
        let offset = u32::try_from(bytes.len())
            .map_err(|_| bad("metadata.exifTags: EXIF exceeds TIFF offset range".into()))?;
        bytes.extend(payload);
        order.u32(offset)
    };
    Ok(Entry {
        format,
        count,
        value,
    })
}

fn append_ifd(
    bytes: &mut Vec<u8>,
    order: ByteOrder,
    directory: &Directory,
    next: u32,
) -> Result<u32> {
    if directory.is_empty() && next == 0 {
        return Ok(0);
    }
    if bytes.len() % 2 != 0 {
        bytes.push(0);
    }
    let offset = u32::try_from(bytes.len()).map_err(|_| malformed())?;
    let count = u16::try_from(directory.len()).map_err(|_| malformed())?;
    bytes.extend(order.u16(count));
    for (tag, entry) in directory {
        bytes.extend(order.u16(*tag));
        bytes.extend(order.u16(entry.format));
        bytes.extend(order.u32(entry.count));
        bytes.extend(entry.value);
    }
    bytes.extend(order.u32(next));
    Ok(offset)
}

fn link(directory: &mut Directory, tag: u16, offset: u32, order: ByteOrder) {
    if offset == 0 {
        directory.remove(&tag);
    } else {
        directory.insert(
            tag,
            Entry {
                format: 4,
                count: 1,
                value: order.u32(offset),
            },
        );
    }
}

/// Author all five standard EXIF directories; `source` is the input's bare TIFF
/// block only for merge. The original image/container is never changed.
pub fn author_exif(tags: &ExifTags, source: Option<&[u8]>) -> Result<Vec<u8>> {
    let canonical = source.map(|bytes| crate::raster_meta::canonical_exif(bytes).0);
    let mut bytes = canonical.map_or_else(|| b"II\x2a\0\0\0\0\0".to_vec(), |bytes| bytes.to_vec());
    let order = if bytes.starts_with(b"II\x2a\0") {
        ByteOrder(true)
    } else if bytes.starts_with(b"MM\0\x2a") {
        ByteOrder(false)
    } else {
        return Err(malformed());
    };
    if bytes.len() < 8 {
        return Err(malformed());
    }
    let (mut directories, tails) = read_directories(&bytes, order)?;
    for (name, entries) in tags {
        let ifd = ifd_number(name)?;
        for (name, text) in entries {
            let (tag, format, count, payload) = values::encode(name, text, order)?;
            if [0x8769, 0x8825, 0xa005, 0x0201, 0x0202].contains(&tag) {
                return Err(bad(format!(
                    "metadata.exifTags: {name} is a structural pointer, use its IFD object"
                )));
            }
            directories[ifd].insert(tag, add_payload(&mut bytes, order, format, payload, count)?);
        }
    }
    // Empty authoring is still a valid EXIF block, as withExif({}) is in sharp.
    directories[0].entry(0x0112).or_insert(Entry {
        format: 3,
        count: 1,
        value: [order.u16(1)[0], order.u16(1)[1], 0, 0],
    });
    let interop = append_ifd(&mut bytes, order, &directories[4], tails[4])?;
    link(&mut directories[2], 0xa005, interop, order);
    let exif = append_ifd(&mut bytes, order, &directories[2], tails[2])?;
    let gps = append_ifd(&mut bytes, order, &directories[3], tails[3])?;
    link(&mut directories[0], 0x8769, exif, order);
    link(&mut directories[0], 0x8825, gps, order);
    let thumbnail = append_ifd(&mut bytes, order, &directories[1], tails[1])?;
    let root = append_ifd(&mut bytes, order, &directories[0], thumbnail)?;
    bytes[4..8].copy_from_slice(&order.u32(root));
    Ok(bytes)
}

#[cfg(test)]
#[path = "raster_exif_author_tests.rs"]
mod tests;
