//! Nested-element XMP I/O for local adjustments (#358), canonical form.
//!
//! Slice 1 of #280 shipped `papp:LocalAdjustments`: a single XMP attribute
//! holding compact JSON (see [`crate::types::local_adjustment::wire`]). That
//! format is parser-cheap but opaque to every reference renderer — ACR and
//! Lightroom have no idea what a `papp:` JSON blob means, so a Maple-authored
//! local adjustment silently vanished on export/import round trips through
//! those tools. This module replaces it with the canonical Adobe Camera Raw
//! shape: `crs:GradientBasedCorrections` (linear masks) and
//! `crs:CircularGradientBasedCorrections` (radial masks), each an `rdf:Seq`
//! of `rdf:li` → `rdf:Description` "corrections", each carrying the
//! `crs:Local*2012` sliders and one `crs:CorrectionMasks` mask descriptor:
//!
//! ```xml
//! <crs:GradientBasedCorrections>
//!   <rdf:Seq>
//!     <rdf:li>
//!       <rdf:Description
//!         crs:What="Correction"
//!         crs:CorrectionAmount="1"
//!         crs:CorrectionActive="True"
//!         crs:LocalExposure2012="0.5"
//!         crs:LocalContrast2012="10">
//!         <crs:CorrectionMasks>
//!           <rdf:Seq>
//!             <rdf:li
//!               crs:What="Mask/Gradient"
//!               crs:MaskValue="1"
//!               crs:ZeroX="0.2" crs:ZeroY="0.3"
//!               crs:FullX="0.8" crs:FullY="0.7"
//!               papp:LocalFeather="0.5"/>
//!           </rdf:Seq>
//!         </crs:CorrectionMasks>
//!       </rdf:Description>
//!     </rdf:li>
//!   </rdf:Seq>
//! </crs:GradientBasedCorrections>
//! ```
//!
//! **Migration.** The old `papp:LocalAdjustments` attribute is still *read*
//! (`xmp::fields::set_field`, tolerant JSON decode in
//! [`crate::types::local_adjustment::wire`]) — a hand-authored fixture from
//! before this ticket still loads — but is never written again. When a
//! document carries both (should not happen outside a hand-edited fixture),
//! the canonical nested form wins: [`super::parse`] applies the legacy
//! attribute first (document order, wherever it appears) and then
//! overwrites `model.local_adjustments` with whatever this walker collected,
//! iff it collected at least one layer. `docs/xmp-canonical-format.md` §
//! "Local adjustments" states this precedence rule.
//!
//! **Field mapping.** Adobe's local-correction struct has no `Vibrance`
//! control (only `LocalSaturation`), so `vibrance` rides Maple's own
//! `papp:LocalVibrance` — same "papp: for what Adobe has no equivalent for"
//! rule the top-level schema follows. Every other `PartialAdjustments` field
//! has a direct Adobe key (`crs:Local{Exposure,Contrast,Highlights,Shadows,
//! Whites,Blacks}2012`, `crs:LocalSaturation`, `crs:Local{Temperature,Tint}`).
//!
//! **Mask geometry.** Maple's [`Mask::Linear`] maps directly onto Adobe's
//! `ZeroX/ZeroY` (0%-effect line) → `FullX/FullY` (100%-effect line) pair —
//! but Adobe's linear mask carries no separate feather magnitude; the
//! Zero→Full distance *is* its transition. Maple's `feather` (a fraction of
//! gradient length, independent of the endpoints) has no Adobe home, so it
//! rides `papp:LocalFeather`; a foreign (ACR-authored) gradient without that
//! attribute defaults to `0.5`, matching [`LocalAdjustment::linear`]'s own
//! default. [`Mask::Radial`] maps onto Adobe's bounding-box form
//! (`Top/Left/Bottom/Right` = `center ± radii`, `Angle` in degrees,
//! `Feather` 0–100, `Flipped` = `invert`); Adobe's `Roundness` (ellipse vs.
//! rounded-rect blend) and `Midpoint` (where the 100%→0% falloff begins)
//! have no Maple equivalent, so the writer fixes them at Adobe's own
//! "pure ellipse, full-strength core" defaults (`Roundness="0"`,
//! `Midpoint="50"`) and the reader ignores both on import — a foreign
//! radial mask with non-zero `Roundness` imports as the nearest ellipse
//! rather than failing, since the ticket's bar is "reasonable results
//! in a third-party renderer", not exact re-derivation of Maple's UI state
//! from arbitrary foreign masks.
//!
//! **Cross-type order.** Adobe's schema keeps linear and radial corrections
//! in two separate top-level arrays, so a document with layers interleaved
//! in the model (linear, radial, linear, …) round-trips through the wire
//! form as two contiguous runs (all linear, then all radial) rather than
//! preserving cross-type interleaving. No UI writes this format yet, so nothing
//! observes that reordering today; it is called out here so it isn't
//! rediscovered as a bug later.
//!
//! **Tolerant reader**, matching [`crate::types::local_adjustment::wire`]'s
//! stated contract for this feature: a `crs:CorrectionMasks` entry whose
//! `crs:What` is not `Mask/Gradient` or `Mask/CircularGradient` (a brush,
//! range, or AI mask — none of which Maple models) is skipped, which drops
//! that one correction (no mask ⇒ nothing to render) without failing the
//! whole subtree or the parse. A *recognized* mask's core geometry
//! (`ZeroX/ZeroY/FullX/FullY` for a gradient; `Top/Left/Bottom/Right` for a
//! circular gradient) is **required** — missing or non-numeric is a hard
//! parse error rather than a silently invented `0`/`1` default, matching
//! every other known key in the schema (`docs/xmp-canonical-format.md` §
//! "Enum fields and parse strictness"). Everything else on a recognized
//! mask or correction (feather, angle, flip, the bookkeeping attributes) is
//! optional with Adobe's own default.
//!
//! **`CorrectionActive` / `CorrectionAmount`.** Both are honoured on read,
//! not just written unconditionally: `crs:CorrectionActive="False"` drops
//! the whole correction (Lightroom's own "disabled pin" semantics — Maple
//! has no UI state for a present-but-inactive layer, so there is nothing to
//! keep it as), and `crs:CorrectionAmount` (Adobe's 0–1 overall-strength
//! dial) scales every wired `PartialAdjustments` field by that amount at
//! parse time — the same effect Adobe's own Amount slider has on its stored
//! per-control deltas, so a `0.5`-amount correction round-trips as the
//! already-halved values rather than carrying the multiplier separately
//! (Maple's model has no field for it).
//!
//! **Mask leaf serialization.** A mask `rdf:li` is always self-closing on
//! write, but a reader accepts either XML shape for it — `<rdf:li .../>`
//! (`Event::Empty`) or the equivalent no-text open/close pair `<rdf:li
//! ...></rdf:li>` (`Event::Start` immediately followed by `Event::End`) —
//! since both are the same document to any namespace-aware XML tool and a
//! third-party writer is free to prefer either.

use super::AdjustmentModel;
use crate::error::Result;
use crate::types::local_adjustment::{LocalAdjustment, Mask, PartialAdjustments};
use quick_xml::events::BytesStart;

mod parse;
mod serialize;

use parse::{parse_correction_attrs, parse_mask_attrs};
pub use serialize::serialize_local_adjustments;

const LINEAR_CONTAINER: &str = "crs:GradientBasedCorrections";
const RADIAL_CONTAINER: &str = "crs:CircularGradientBasedCorrections";
const MASKS: &str = "crs:CorrectionMasks";
const MASK_WHAT_LINEAR: &str = "Mask/Gradient";
const MASK_WHAT_RADIAL: &str = "Mask/CircularGradient";

/// Mask-container flavor. Private to this module tree; `parse` and
/// `serialize` reach it via `super::Kind`, since a private item is visible
/// to its defining module's descendants.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Linear,
    Radial,
}

fn is_seq(name: &str) -> bool {
    name == "Seq" || name.ends_with(":Seq")
}
fn is_li(name: &str) -> bool {
    name == "li" || name.ends_with(":li")
}
fn is_description(name: &str) -> bool {
    name == "Description" || name.ends_with(":Description")
}

/// A correction whose `rdf:Description` is open but not yet closed.
struct InProgressCorrection {
    adjustments: PartialAdjustments,
    active: bool,
    /// `Some` once its `crs:CorrectionMasks` leaf has been recognized.
    mask: Option<Mask>,
}

/// Incremental state for the local-adjustments nested-element walk, driven
/// by [`super::parse`] exactly like [`super::tone_curves::CurveWalker`].
/// Explicit fields rather than a generic stack: the schema this walks is a
/// single fixed shape six levels deep, not an arbitrary tree.
#[derive(Default)]
pub(super) struct LocalAdjustmentsWalker {
    container: Option<Kind>,
    in_container_seq: bool,
    in_layer_li: bool,
    /// `Some` once inside a correction's `rdf:Description`.
    current: Option<InProgressCorrection>,
    in_masks: bool,
    in_masks_seq: bool,
    finished: Vec<LocalAdjustment>,
}

impl LocalAdjustmentsWalker {
    /// Handle an element opening (`Event::Start`). Returns `true` when the
    /// element is part of (or opens) a local-adjustments subtree, in which
    /// case the caller skips the flat crs:/papp: attribute walk for it.
    pub(super) fn start(&mut self, name: &str, e: &BytesStart<'_>) -> Result<bool> {
        if self.container.is_none() {
            self.container = match name {
                LINEAR_CONTAINER => Some(Kind::Linear),
                RADIAL_CONTAINER => Some(Kind::Radial),
                _ => None,
            };
            return Ok(self.container.is_some());
        }
        if self.current.is_none() {
            if !self.in_container_seq && is_seq(name) {
                self.in_container_seq = true;
                return Ok(true);
            }
            if self.in_container_seq && !self.in_layer_li && is_li(name) {
                self.in_layer_li = true;
                return Ok(true);
            }
            if self.in_layer_li && is_description(name) {
                let attrs = parse_correction_attrs(e)?;
                self.current = Some(InProgressCorrection {
                    adjustments: attrs.adjustments,
                    active: attrs.active,
                    mask: None,
                });
                return Ok(true);
            }
            // Stray content inside the container we don't otherwise
            // recognize — swallow it rather than let it hit the flat
            // attribute walk, but don't model it.
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
        // self-closing (`<rdf:li ...></rdf:li>`) arrives here as `Start`
        // (with `End` immediately following and no text in between) rather
        // than through `empty()` — recognize it the same way so a
        // third-party writer's XML-shape choice doesn't silently drop the
        // mask (Copilot / Jules review on #3212).
        if self.in_masks_seq {
            self.record_mask(name, e)?;
            return Ok(true);
        }
        Ok(true)
    }

    /// Handle a self-closing element (`Event::Empty`) — Maple's own writer
    /// always emits mask `rdf:li` leaves this way. Returns `true` when
    /// handled.
    pub(super) fn empty(&mut self, name: &str, e: &BytesStart<'_>) -> Result<bool> {
        if self.container.is_none() {
            return Ok(false);
        }
        if self.in_masks_seq {
            self.record_mask(name, e)?;
            return Ok(true);
        }
        Ok(true)
    }

    /// Shared body for both XML shapes a mask leaf can take (`Event::Empty`
    /// or a no-text `Event::Start`/`Event::End` pair) — parses `e`'s
    /// attributes into a `Mask` and stores it on the in-progress correction,
    /// first-recognized-mask-wins (tolerates a document with more than one
    /// `rdf:li` under `CorrectionMasks`, e.g. a future intersection of
    /// masks Maple doesn't model alongside one it does).
    fn record_mask(&mut self, name: &str, e: &BytesStart<'_>) -> Result<()> {
        if !is_li(name) {
            return Ok(());
        }
        let Some(cur) = self.current.as_mut() else {
            return Ok(());
        };
        if cur.mask.is_none() {
            let kind = self.container.expect("container set while in_masks_seq");
            cur.mask = parse_mask_attrs(kind, e)?;
        }
        Ok(())
    }

    /// Handle an element closing (`Event::End`).
    pub(super) fn end(&mut self, name: &str) {
        if self.container.is_none() {
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
                // Active + a recognized mask ⇒ commit. Inactive (disabled
                // pin) or no mask (unrecognized `What`, or none at all) ⇒
                // drop this one correction.
                if cur.active {
                    if let Some(mask) = cur.mask {
                        self.finished.push(LocalAdjustment {
                            mask,
                            adjustments: cur.adjustments,
                        });
                    }
                }
            } else {
                // Not the Description closing yet (e.g. the End half of a
                // non-self-closing mask li) — put the in-progress
                // correction back and keep waiting.
                self.current = Some(cur);
            }
            return;
        }
        if self.in_layer_li {
            if is_li(name) {
                self.in_layer_li = false;
            }
            return;
        }
        if self.in_container_seq {
            if is_seq(name) {
                self.in_container_seq = false;
            }
            return;
        }
        if name == LINEAR_CONTAINER || name == RADIAL_CONTAINER {
            self.container = None;
        }
    }

    /// Consume the walker, returning every layer collected across both
    /// containers in document order (all `GradientBasedCorrections` layers,
    /// then all `CircularGradientBasedCorrections` layers, matching
    /// whichever container the document listed first — Maple's own writer
    /// always emits linear before radial, see [`serialize_local_adjustments`]).
    pub(super) fn finish(self) -> Vec<LocalAdjustment> {
        self.finished
    }
}
