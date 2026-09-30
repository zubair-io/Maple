//! Classic TIFF/BigTIFF IFD fields and page chains, without reading strip data.

use super::{HeaderFields, MetadataSource};
use std::collections::HashSet;

struct Tiff<'a, S: ?Sized> {
    bytes: &'a S,
    little: bool,
    big: bool,
}
impl<'a, S: MetadataSource + ?Sized> Tiff<'a, S> {
    fn open(bytes: &'a S) -> Option<Self> {
        let little = bytes.starts_with(b"II");
        if !little && !bytes.starts_with(b"MM") {
            return None;
        }
        let plain = Self {
            bytes,
            little,
            big: false,
        };
        match plain.number(2, 2)? {
            42 => Some(plain),
            43 if plain.number(4, 2) == Some(8) && plain.number(6, 2) == Some(0) => {
                Some(Self { big: true, ..plain })
            }
            _ => None,
        }
    }
    fn number(&self, at: usize, length: usize) -> Option<u64> {
        let bytes = self.bytes.get(at..at.checked_add(length)?)?;
        Some(if self.little {
            bytes.iter().rev().fold(0, |n, &b| (n << 8) | u64::from(b))
        } else {
            bytes.iter().fold(0, |n, &b| (n << 8) | u64::from(b))
        })
    }
    fn first(&self) -> Option<usize> {
        usize::try_from(self.number(if self.big { 8 } else { 4 }, self.offset_size())?).ok()
    }
    fn offset_size(&self) -> usize {
        if self.big {
            8
        } else {
            4
        }
    }
    fn count_size(&self) -> usize {
        if self.big {
            8
        } else {
            2
        }
    }
    fn entry_size(&self) -> usize {
        if self.big {
            20
        } else {
            12
        }
    }
    fn count(&self, ifd: usize) -> Option<usize> {
        let count = usize::try_from(self.number(ifd, self.count_size())?).ok()?;
        let end = ifd
            .checked_add(self.count_size())?
            .checked_add(count.checked_mul(self.entry_size())?)?;
        self.bytes
            .contains(ifd..end.checked_add(self.offset_size())?)
            .then_some(count)
    }
    fn value(&self, ifd: usize, wanted: u16) -> Option<u64> {
        for i in 0..self.count(ifd)? {
            let at = ifd
                .checked_add(self.count_size())?
                .checked_add(i.checked_mul(self.entry_size())?)?;
            if self.number(at, 2)? != u64::from(wanted) {
                continue;
            }
            let kind = self.number(at.checked_add(2)?, 2)?;
            let size = match kind {
                1 => 1,
                3 => 2,
                4 => 4,
                16 => 8,
                _ => return None,
            };
            let count_at = at.checked_add(4)?;
            let count =
                usize::try_from(self.number(count_at, if self.big { 8 } else { 4 })?).ok()?;
            if count == 0 {
                return None;
            }
            let value_at = count_at.checked_add(if self.big { 8 } else { 4 })?;
            let payload = if count.checked_mul(size)? > self.offset_size() {
                usize::try_from(self.number(value_at, self.offset_size())?).ok()?
            } else {
                value_at
            };
            return self.number(payload, size);
        }
        None
    }
    fn next(&self, ifd: usize) -> Option<usize> {
        let at = ifd
            .checked_add(self.count_size())?
            .checked_add(self.count(ifd)?.checked_mul(self.entry_size())?)?;
        usize::try_from(self.number(at, self.offset_size())?).ok()
    }
}

pub(super) fn unit<S: MetadataSource + ?Sized>(
    bytes: &S,
    default_inch: bool,
) -> Option<&'static str> {
    let tiff = Tiff::open(bytes)?;
    match tiff.value(tiff.first()?, 296) {
        Some(3) => Some("cm"),
        Some(2) => Some("inch"),
        Some(1) => None,
        _ if default_inch => Some("inch"),
        _ => None,
    }
}

pub(super) fn fields(bytes: &impl MetadataSource) -> HeaderFields {
    let Some(tiff) = Tiff::open(bytes) else {
        return HeaderFields::default();
    };
    let Some(first) = tiff.first() else {
        return HeaderFields::default();
    };
    let bits = tiff
        .value(first, 258)
        .and_then(|bits| u8::try_from(bits).ok());
    let mut visited = HashSet::new();
    let mut at = first;
    while at != 0 && !visited.contains(&at) && tiff.count(at).is_some() {
        visited.insert(at);
        let Some(next) = tiff.next(at) else { break };
        at = next;
    }
    let grayscale = matches!(tiff.value(first, 262), Some(0 | 1));
    HeaderFields {
        grayscale,
        source_channels: source_channels(bytes),
        bits_per_sample: bits,
        pages: (!visited.is_empty()).then_some(visited.len()),
        resolution_unit: unit(bytes, true),
        ..Default::default()
    }
}

pub(super) fn source_channels<S: MetadataSource + ?Sized>(bytes: &S) -> Option<u8> {
    let tiff = Tiff::open(bytes)?;
    let first = tiff.first()?;
    if !matches!(tiff.value(first, 262), Some(0 | 1)) {
        return None;
    }
    tiff.value(first, 277).and_then(|n| u8::try_from(n).ok())
}
