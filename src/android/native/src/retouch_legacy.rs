//! Retires Lightroom's legacy `crs:RetouchInfo` list once Android authors the
//! structured one (#5904). raw-core falls back to the legacy strings whenever
//! no structured spot is left (`RetouchWalker::finish`), so every entry it
//! decodes goes; everything else in the container (undecodable entries,
//! attributes, other children) keeps its bytes. A container left with nothing
//! but empty sequences is removed.
use crate::mask_document::parse_piece;
use crate::mask_xml::Element;
use crate::retouch_document::Container;
use raw_core::types::RetouchSpot;
use std::ops::Range;

/// The entries of `container` raw-core decodes, each with the `rdf:li` it was
/// read from, in document order. Entries under a sequence raw-core reads in
/// some other shape are not listed; the caller falls back to the whole
/// container's spots for those.
pub fn decoded(container: &Container) -> Result<Vec<(Element, RetouchSpot)>, String> {
    let text = &container.text;
    let root = &container.root;
    let root_close = text[..root.span.end]
        .rfind("</")
        .ok_or("Malformed legacy repair list")?;
    let mut entries = Vec::new();
    for seq in &root.children {
        if !seq.is("rdf:Seq") || seq.self_closing() {
            continue;
        }
        let close = text[..seq.span.end]
            .rfind("</")
            .ok_or("Malformed legacy repair list")?;
        for item in &seq.children {
            if !item.is("rdf:li") {
                continue;
            }
            let piece = format!(
                "{}{}{}{}{}",
                &text[root.start.clone()],
                &text[seq.start.clone()],
                &text[item.span.clone()],
                &text[close..seq.span.end],
                &text[root_close..root.span.end]
            );
            if let Some(spot) = parse_piece(&piece, &container.scope)?.retouch_spots.first() {
                entries.push((item.clone(), *spot));
            }
        }
    }
    Ok(entries)
}

/// `container` without the entries raw-core decodes, or `""` when nothing
/// else is left in it.
pub fn retired(container: &Container) -> Result<String, String> {
    let text = &container.text;
    let root = &container.root;
    let root_close = text[..root.span.end]
        .rfind("</")
        .ok_or("Malformed legacy repair list")?;
    let mut removed: Vec<Range<usize>> = Vec::new();
    let mut emptied = !root.has_attributes() && !root.mixed;
    for seq in &root.children {
        if !seq.is("rdf:Seq") || seq.self_closing() {
            emptied = false;
            continue;
        }
        emptied &= !seq.has_attributes() && !seq.mixed;
        let close = text[..seq.span.end]
            .rfind("</")
            .ok_or("Malformed legacy repair list")?;
        for item in &seq.children {
            let piece = format!(
                "{}{}{}{}{}",
                &text[root.start.clone()],
                &text[seq.start.clone()],
                &text[item.span.clone()],
                &text[close..seq.span.end],
                &text[root_close..root.span.end]
            );
            if parse_piece(&piece, &container.scope)?
                .retouch_spots
                .is_empty()
            {
                emptied = false;
            } else {
                removed.push(text[..item.span.start].trim_end().len()..item.span.end);
            }
        }
    }
    if emptied {
        return Ok(String::new());
    }
    let mut out = String::new();
    let mut cursor = root.span.start;
    for range in removed {
        out.push_str(&text[cursor..range.start]);
        cursor = range.end;
    }
    out.push_str(&text[cursor..root.span.end]);
    if !parse_piece(&out, &container.scope)?
        .retouch_spots
        .is_empty()
    {
        return Err(
            "A legacy repair list Android cannot retire; edit its spots in Maple on a Mac or iPad"
                .into(),
        );
    }
    Ok(out)
}
