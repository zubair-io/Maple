//! Top-level AVIF image items (excluding auxiliary and thumbnail items).

use super::{HeaderFields, MetadataSource};
use std::collections::HashSet;

fn number(bytes: &[u8]) -> usize {
    bytes.iter().fold(0, |n, &b| (n << 8) | b as usize)
}
fn boxes(bytes: &[u8]) -> impl Iterator<Item = ([u8; 4], &[u8])> {
    let mut at = 0usize;
    std::iter::from_fn(move || {
        let header = bytes.get(at..at.checked_add(8)?)?;
        let size = number(&header[..4]);
        let (size, skip) = match size {
            0 => (bytes.len().checked_sub(at)?, 8),
            1 => (
                usize::try_from(u64::from_be_bytes(
                    bytes.get(at + 8..at.checked_add(16)?)?.try_into().ok()?,
                ))
                .ok()?,
                16,
            ),
            n => (n, 8),
        };
        let end = at.checked_add(size)?;
        let payload = bytes.get(at.checked_add(skip)?..end)?;
        let kind = header[4..8].try_into().ok()?;
        at = end;
        Some((kind, payload))
    })
}
fn child<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(bytes).find(|(k, _)| k == kind).map(|(_, p)| p)
}

pub(super) fn fields(bytes: &impl MetadataSource) -> HeaderFields {
    // Top-level payloads are skipped by offset; only meta is materialized.
    let mut at = 0usize;
    let meta = loop {
        let Some(header) = bytes.get(at..at.saturating_add(8)) else {
            return HeaderFields::default();
        };
        let size = number(&header[..4]);
        let (size, skip) = match size {
            0 => (bytes.len().saturating_sub(at), 8),
            1 => {
                let Some(wide) = bytes.get(at.saturating_add(8)..at.saturating_add(16)) else {
                    return HeaderFields::default();
                };
                let Ok(size) =
                    usize::try_from(u64::from_be_bytes(wide.as_ref().try_into().unwrap()))
                else {
                    return HeaderFields::default();
                };
                (size, 16)
            }
            n => (n, 8),
        };
        let Some(end) = at
            .checked_add(size)
            .filter(|&end| size >= skip && end <= bytes.len())
        else {
            return HeaderFields::default();
        };
        if &header[4..8] == b"meta" {
            break bytes.get(at + skip..end).unwrap_or_default();
        }
        at = end;
    };
    let Some(children) = meta.get(4..) else {
        return HeaderFields::default();
    };
    let primary = child(children, b"pitm").and_then(|pitm| {
        let width = match pitm.first()? {
            0 => 2,
            1 => 4,
            _ => return None,
        };
        Some(number(pitm.get(4..4 + width)?))
    });
    let mut excluded = HashSet::new();
    if let Some(iref) = child(children, b"iref") {
        let width = match iref.first() {
            Some(0) => 2,
            Some(1) => 4,
            _ => 0,
        };
        if width != 0 {
            for (kind, payload) in boxes(iref.get(4..).unwrap_or_default()) {
                if matches!(&kind, b"auxl" | b"thmb") {
                    if let Some(id) = payload.get(..width) {
                        excluded.insert(number(id));
                    }
                }
            }
        }
    }
    let images = child(children, b"iinf")
        .map(|iinf| {
            let start = if iinf.first() == Some(&0) { 6 } else { 8 };
            let mut images = boxes(iinf.get(start..).unwrap_or_default())
                .filter_map(|(kind, infe)| {
                    if &kind != b"infe" || infe.get(3).is_some_and(|flag| flag & 1 != 0) {
                        return None;
                    }
                    let width = match infe.first()? {
                        2 => 2,
                        3 => 4,
                        _ => return None,
                    };
                    let id = number(infe.get(4..4 + width)?);
                    let kind = infe.get(6 + width..10 + width)?;
                    (matches!(kind, b"av01" | b"grid") && !excluded.contains(&id)).then_some(id)
                })
                .collect::<Vec<_>>();
            images.sort_unstable();
            images.dedup();
            images
        })
        .unwrap_or_default();
    HeaderFields {
        pages: (!images.is_empty()).then_some(images.len()),
        page_primary: primary.and_then(|primary| images.iter().position(|&id| id == primary)),
        compression: Some("av1"),
        ..Default::default()
    }
}
