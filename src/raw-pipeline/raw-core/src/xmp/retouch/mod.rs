//! Nested-element XMP I/O for clone / heal repair spots (#3409).
//!
//! Adobe stores repair spots in `crs:RetouchAreas`: an `rdf:Seq` of
//! corrections, each an `rdf:Description` naming the spot type and the
//! source point, with the destination disc carried by a nested
//! `crs:Masks` leaf. Maple writes exactly that shape, so a spot authored
//! here renders in Lightroom and a Lightroom-authored spot loads here:
//!
//! ```xml
//! <crs:RetouchAreas>
//!   <rdf:Seq>
//!     <rdf:li>
//!       <rdf:Description
//!         crs:SpotType="heal"
//!         crs:SourceState="sourceSetExplicitly"
//!         crs:Method="circle"
//!         crs:SourceX="0.750000"
//!         crs:SourceY="0.500000"
//!         crs:Opacity="1.000000"
//!         crs:Feather="0.500000"
//!         crs:Seed="0">
//!         <crs:Masks>
//!           <rdf:Seq>
//!             <rdf:li
//!               crs:What="Mask/CircularGradient"
//!               crs:MaskValue="1"
//!               crs:X="0.250000"
//!               crs:Y="0.500000"
//!               crs:Radius="0.050000"
//!               crs:Flow="1"
//!               crs:CenterWeight="0"/>
//!           </rdf:Seq>
//!         </crs:Masks>
//!       </rdf:Description>
//!     </rdf:li>
//!   </rdf:Seq>
//! </crs:RetouchAreas>
//! ```
//!
//! **Radius basis.** `crs:Radius` is a fraction of the image WIDTH and the
//! spot is a circle in pixels — see `types::retouch`'s module doc for why a
//! repair disc cannot use the normalised-space ellipse convention masks use.
//!
//! **Number formatting.** Six decimals, matching `crs:Crop*` and Adobe's own
//! retouch output. The two-decimal wire precision the local-adjustment
//! sliders use would quantise a spot centre to 1 % of the frame — coarser
//! than the dust spots this tool exists for.
//!
//! **Legacy form.** Older Lightroom versions wrote `crs:RetouchInfo`: an
//! `rdf:Seq` of `key = value` strings. That form is READ (so an old sidecar's
//! spots survive an import) and never written. When a document carries both,
//! `crs:RetouchAreas` wins — same precedence rule the local-adjustment
//! walker applies to its own legacy attribute.
//!
//! **Tolerant reader.** A correction whose `crs:SpotType` this build does not
//! model, or whose mask leaf is not the circular form (a Lightroom brush
//! stroke, `Mask/Paint`), is skipped: that drops one spot rather than failing
//! the document. A *recognised* leaf with a malformed number is a hard parse
//! error, matching the strictness rule the rest of the schema follows.

use super::AdjustmentModel;
use crate::error::Result;
use crate::types::retouch::RetouchSpot;
use quick_xml::events::BytesStart;

mod parse;
mod serialize;

pub use serialize::serialize_retouch_areas;

const AREAS_CONTAINER: &str = "crs:RetouchAreas";
const LEGACY_CONTAINER: &str = "crs:RetouchInfo";
const MASKS: &str = "crs:Masks";
const MASK_WHAT_CIRCULAR: &str = "Mask/CircularGradient";

fn is_seq(name: &str) -> bool {
    name == "Seq" || name.ends_with(":Seq")
}
fn is_li(name: &str) -> bool {
    name == "li" || name.ends_with(":li")
}
fn is_description(name: &str) -> bool {
    name == "Description" || name.ends_with(":Description")
}

/// Which container the walker is currently inside.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Container {
    /// `crs:RetouchAreas` — the struct form Maple reads and writes.
    Areas,
    /// `crs:RetouchInfo` — the legacy string form, read only.
    Legacy,
}

/// A correction whose `rdf:Description` is open but not yet closed.
struct InProgressSpot {
    attrs: parse::SpotAttrs,
    /// `Some` once a circular mask leaf has been recognised.
    mask: Option<parse::MaskAttrs>,
}

/// Incremental state for the retouch nested-element walk, driven by
/// [`super::parse`] the way `LocalAdjustmentsWalker` and `CurveWalker` are.
#[derive(Default)]
pub(super) struct RetouchWalker {
    container: Option<Container>,
    in_container_seq: bool,
    in_li: bool,
    current: Option<InProgressSpot>,
    in_masks: bool,
    in_masks_seq: bool,
    /// Text accumulator for one legacy `rdf:li` body.
    legacy_text: String,
    areas: Vec<RetouchSpot>,
    legacy: Vec<RetouchSpot>,
}

impl RetouchWalker {
    /// Handle an element opening. Returns `true` when the element belongs to
    /// (or opens) a retouch subtree, in which case the caller skips the flat
    /// attribute walk for it.
    pub(super) fn start(&mut self, name: &str, e: &BytesStart<'_>) -> Result<bool> {
        let Some(container) = self.container else {
            self.container = match name {
                AREAS_CONTAINER => Some(Container::Areas),
                LEGACY_CONTAINER => Some(Container::Legacy),
                _ => None,
            };
            return Ok(self.container.is_some());
        };
        if container == Container::Legacy {
            if !self.in_container_seq && is_seq(name) {
                self.in_container_seq = true;
            } else if self.in_container_seq && is_li(name) {
                self.in_li = true;
                self.legacy_text.clear();
            }
            return Ok(true);
        }
        if self.current.is_none() {
            if !self.in_container_seq && is_seq(name) {
                self.in_container_seq = true;
                return Ok(true);
            }
            if self.in_container_seq && !self.in_li && is_li(name) {
                self.in_li = true;
                return Ok(true);
            }
            if self.in_li && is_description(name) {
                self.current = Some(InProgressSpot {
                    attrs: parse::parse_spot_attrs(e)?,
                    mask: None,
                });
            }
            return Ok(true);
        }
        if !self.in_masks && name == MASKS {
            self.in_masks = true;
            return Ok(true);
        }
        if self.in_masks && !self.in_masks_seq && is_seq(name) {
            self.in_masks_seq = true;
            return Ok(true);
        }
        // A mask leaf written as an explicit open/close pair rather than
        // self-closing arrives here; recognise it the same way `empty` does.
        if self.in_masks_seq {
            self.record_mask(name, e)?;
        }
        Ok(true)
    }

    /// Handle a self-closing element — Maple's own writer always emits the
    /// mask leaf this way.
    pub(super) fn empty(&mut self, name: &str, e: &BytesStart<'_>) -> Result<bool> {
        if self.container.is_none() {
            return Ok(false);
        }
        if self.in_masks_seq {
            self.record_mask(name, e)?;
        }
        Ok(true)
    }

    /// Accumulate text, which only matters inside a legacy `rdf:li`.
    pub(super) fn text(&mut self, text: &str) {
        if self.container == Some(Container::Legacy) && self.in_li {
            self.legacy_text.push_str(text);
        }
    }

    fn record_mask(&mut self, name: &str, e: &BytesStart<'_>) -> Result<()> {
        if !is_li(name) {
            return Ok(());
        }
        let Some(cur) = self.current.as_mut() else {
            return Ok(());
        };
        if cur.mask.is_none() {
            cur.mask = parse::parse_mask_attrs(e)?;
        }
        Ok(())
    }

    /// Handle an element closing.
    pub(super) fn end(&mut self, name: &str) {
        let Some(container) = self.container else {
            return;
        };
        if container == Container::Legacy {
            self.end_legacy(name);
            return;
        }
        if self.in_masks_seq {
            if is_seq(name) {
                self.in_masks_seq = false;
            }
            return;
        }
        if self.in_masks {
            if name == MASKS {
                self.in_masks = false;
            }
            return;
        }
        if let Some(cur) = self.current.take() {
            if is_description(name) {
                if let Some(mask) = cur.mask.as_ref() {
                    if let Some(spot) = parse::assemble(&cur.attrs, mask) {
                        self.areas.push(spot);
                    }
                }
            } else {
                // Not the Description closing yet (the End half of a
                // non-self-closing mask leaf) — keep waiting.
                self.current = Some(cur);
            }
            return;
        }
        if self.in_li {
            if is_li(name) {
                self.in_li = false;
            }
            return;
        }
        if self.in_container_seq {
            if is_seq(name) {
                self.in_container_seq = false;
            }
            return;
        }
        if name == AREAS_CONTAINER {
            self.container = None;
        }
    }

    fn end_legacy(&mut self, name: &str) {
        if self.in_li && is_li(name) {
            if let Some(spot) = parse::parse_legacy_info(&self.legacy_text) {
                self.legacy.push(spot);
            }
            self.legacy_text.clear();
            self.in_li = false;
            return;
        }
        if self.in_container_seq && is_seq(name) {
            self.in_container_seq = false;
            return;
        }
        if name == LEGACY_CONTAINER {
            self.container = None;
        }
    }

    /// Write whatever this walk collected onto `model`. The struct form wins
    /// whenever it produced at least one spot; the legacy strings are the
    /// fallback for a document that only carries them.
    pub(super) fn finish(self, model: &mut AdjustmentModel) {
        if !self.areas.is_empty() {
            model.retouch_spots = self.areas;
        } else if !self.legacy.is_empty() {
            model.retouch_spots = self.legacy;
        }
    }
}
