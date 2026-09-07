//! Variants, snapshots and semantic history (#2437) — the three nested
//! sidecar blocks that let one RAW carry alternate treatments, named
//! checkpoints, and an action log that survives a relaunch.
//!
//! # What the three blocks are
//!
//! - A **variant** is an immutable id plus its own independent adjustment
//!   branch. The branch does not live in this block: it lives in its own
//!   sidecar file beside the primary one ([`variant_sidecar_name`]). What
//!   the primary sidecar carries is a *manifest* — one entry per variant so
//!   a reader can enumerate them without globbing a directory, and so a
//!   deleted variant leaves a tombstone that a recover action can undo.
//! - A **snapshot** is a named, immutable checkpoint *inside* one variant.
//!   It carries the complete adjustment state it was taken from.
//! - A **history entry** is one committed, user-visible action — the
//!   `EditTransaction` vocabulary the editors already speak (`adjustment`,
//!   `crop`, `paste`, `preset`, `reset`, `snapshot`, `variant`, …) — with
//!   its description, its timestamp, and the state it produced.
//!
//! # Wire form
//!
//! All three are Maple-authored, so all three live in the `papp:`
//! namespace. In particular snapshots are **not** written to Adobe's
//! `crs:Snapshots`: a foreign Lightroom sidecar's own snapshot stack rides
//! the unknown-node passthrough pipe byte-for-byte
//! (`docs/xmp-canonical-format.md` § "Passthrough"), and writing Maple
//! snapshots into that element would both collide with the foreign stack
//! and break the "a Maple writer must not destroy anything it does not
//! understand" rule.
//!
//! ```xml
//! <papp:Variants>
//!   <rdf:Seq>
//!     <rdf:li>
//!       <rdf:Description
//!         papp:VariantId="warm"
//!         papp:VariantName="Warm"
//!         papp:VariantCreated="2026-09-07T10:00:00Z"/>
//!     </rdf:li>
//!   </rdf:Seq>
//! </papp:Variants>
//! <papp:Snapshots>
//!   <rdf:Seq>
//!     <rdf:li>
//!       <rdf:Description
//!         papp:SnapshotName="Before crop"
//!         papp:SnapshotCreated="2026-09-07T10:01:00Z"
//!         papp:Profile="Auto"
//!         papp:Brightness="6"/>
//!     </rdf:li>
//!   </rdf:Seq>
//! </papp:Snapshots>
//! <papp:History>
//!   <rdf:Seq>
//!     <rdf:li>
//!       <rdf:Description
//!         papp:HistoryKind="adjustment"
//!         papp:HistoryDescription="Brightness"
//!         papp:HistoryTime="2026-09-07T10:01:00Z"
//!         papp:Profile="Auto"
//!         papp:Brightness="6"/>
//!     </rdf:li>
//!   </rdf:Seq>
//! </papp:History>
//! ```
//!
//! A non-primary variant's own sidecar additionally carries
//! `papp:VariantId` / `papp:VariantName` as flat attributes on its
//! `rdf:Description`, so a file that got separated from its manifest still
//! identifies itself.
//!
//! # Why full state per entry rather than a delta plus checkpoints
//!
//! `docs/strategy/milestones/m2-global-workflow.md` sketches history as
//! deltas with periodic full-model checkpoints. This module stores the
//! complete state on **every** entry instead, for three reasons, and the
//! result is strictly more precise than the sketch:
//!
//! 1. Every field in the schema is written omit-on-default, so "complete
//!    state" for a real edit is the handful of attributes the photographer
//!    actually moved — a delta codec would save bytes that omit-on-default
//!    already saves.
//! 2. A delta codec is a *second* wire encoding of the same schema that all
//!    four implementations would have to agree on byte-for-byte, which
//!    principle 7 (YAGNI) says not to build before a second caller forces it.
//! 3. With deltas, only checkpoints are exactly restorable; with full state,
//!    every retained entry is. Boundedness comes from [`HISTORY_CAP`] and
//!    [`compact_history`], and compaction provably cannot change what the
//!    image renders as, because the rendered state is the sidecar's own
//!    top-level attributes — history is a record, never an input to the
//!    develop chain.
//!
//! Local adjustments and mask rasters are deliberately **not** part of an
//! entry's state: the milestone spec's own non-goal is "no local-mask
//! history", and #2432's `SidecarDiff` already excludes them for the same
//! reason. Point tone curves are included, as nested children of the
//! entry's `rdf:Description`, because they are ordinary authored state.

use super::fields::set_field;
use super::tone_curves::CurveWalker;
use super::AdjustmentModel;
use crate::error::{Error, Result};
use quick_xml::events::BytesStart;

mod serialize;
pub use serialize::serialize_variants;

#[cfg(test)]
mod tests;

/// The reserved id of the branch stored in the base `<stem>.xmp` sidecar.
/// It is never written to a file and never appears in a manifest — the
/// primary variant *is* the sidecar every Maple build has always written,
/// which is what keeps a variant-naive library readable by a variant-naive
/// reader.
pub const PRIMARY_VARIANT_ID: &str = "primary";

/// Cap on the persisted history log, matching the editors' in-memory undo
/// ring (`UNDO_STACK_CAP` on web, `EditTransactionRing` on Apple) so the
/// panel a user sees and the log that survives a relaunch hold the same
/// number of actions.
pub const HISTORY_CAP: usize = 32;

/// Filename segment that marks a variant sidecar, inserted before the
/// `.xmp` suffix: `IMG_1234.xmp` → `IMG_1234.v-warm.xmp`, and for a video
/// (whose sidecar appends rather than swaps) `clip.mov.xmp` →
/// `clip.mov.v-warm.xmp`.
const VARIANT_MARKER: &str = ".v-";

const VARIANTS_CONTAINER: &str = "papp:Variants";
const SNAPSHOTS_CONTAINER: &str = "papp:Snapshots";
const HISTORY_CONTAINER: &str = "papp:History";

/// One entry in the primary sidecar's variant manifest.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct VariantRecord {
    /// Stable, immutable identity. Constrained by [`is_valid_variant_id`]
    /// because it becomes part of a filename.
    pub id: String,
    /// User-visible label; may be empty.
    pub name: String,
    /// ISO-8601 UTC creation stamp, free-form text to the reader.
    pub created: String,
    /// Tombstone. A deleted variant keeps its manifest entry — and its
    /// sidecar file — so "recover" is a flag flip rather than an
    /// unrecoverable unlink, matching principle 1: nothing a user made is
    /// destroyed by an edit.
    pub deleted: bool,
}

/// A named, immutable checkpoint inside one variant.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub name: String,
    pub created: String,
    /// The complete adjustment state the snapshot was taken from.
    pub model: AdjustmentModel,
}

/// One committed, user-visible action.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HistoryEntry {
    /// The `EditTransaction` action class, verbatim (`adjustment`, `auto`,
    /// `crop`, `paste`, `preset`, `reset`, `mask`, `repair`, `variant`,
    /// `snapshot`). Kept as a string rather than a Rust enum so a sidecar
    /// written by a newer build carrying an action class this build has
    /// never heard of round-trips instead of failing the parse — the same
    /// tolerance `papp:FilmLook` already has for an unknown catalog id.
    pub kind: String,
    /// User-visible description, e.g. "Exposure" or "Pasted from IMG_0007".
    pub description: String,
    /// ISO-8601 UTC stamp.
    pub time: String,
    /// The state this action produced. Restoring the entry means adopting
    /// this model as one undoable transaction.
    pub model: AdjustmentModel,
}

/// Everything a sidecar carries that is *about* the edit rather than part
/// of it. Parsed alongside the [`AdjustmentModel`] by
/// [`super::parse_document`]; absent blocks leave their fields empty, so a
/// variant-naive sidecar produces `Variants::default()`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Variants {
    /// This sidecar's own branch id — empty for the primary sidecar.
    pub variant_id: String,
    /// This sidecar's own branch label — empty for the primary sidecar.
    pub variant_name: String,
    /// The manifest, written in the primary sidecar only.
    pub variants: Vec<VariantRecord>,
    pub snapshots: Vec<Snapshot>,
    pub history: Vec<HistoryEntry>,
}

impl Variants {
    /// The live (non-tombstoned) manifest entries, in document order.
    pub fn live_variants(&self) -> impl Iterator<Item = &VariantRecord> {
        self.variants.iter().filter(|v| !v.deleted)
    }

    /// Look up one manifest entry, tombstoned or not.
    pub fn variant(&self, id: &str) -> Option<&VariantRecord> {
        self.variants.iter().find(|v| v.id == id)
    }
}

/// True for an id that is safe to embed in a filename and stable across
/// the three platforms' path layers: 1–32 characters of ASCII letters,
/// digits, `_` or `-`, and not the reserved primary id.
///
/// The constraint is deliberately tighter than "any string": the id *is*
/// part of a path, so allowing a separator, a dot, or a non-ASCII
/// codepoint would make the same manifest resolve to different files on
/// different filesystems.
pub fn is_valid_variant_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id != PRIMARY_VARIANT_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The sidecar filename for `id`, given the primary sidecar's filename.
/// `None` when the id is not a valid variant id or `primary_name` is not a
/// `.xmp` filename — a caller must never invent a path for an id the
/// manifest could not have contained.
pub fn variant_sidecar_name(primary_name: &str, id: &str) -> Option<String> {
    if !is_valid_variant_id(id) {
        return None;
    }
    let stem = primary_name.strip_suffix(".xmp")?;
    Some(format!("{stem}{VARIANT_MARKER}{id}.xmp"))
}

/// Inverse of [`variant_sidecar_name`]: `("IMG_1234.v-warm.xmp")` →
/// `Some(("IMG_1234.xmp", "warm"))`. `None` for the primary sidecar, for a
/// non-`.xmp` name, and for a marker segment carrying an id this build
/// would refuse to write — an unrecognised sibling stays a stray file
/// rather than being adopted as a variant.
pub fn parse_variant_sidecar_name(name: &str) -> Option<(String, String)> {
    let stem = name.strip_suffix(".xmp")?;
    let (base, id) = stem.rsplit_once(VARIANT_MARKER)?;
    if !is_valid_variant_id(id) {
        return None;
    }
    Some((format!("{base}.xmp"), id.to_string()))
}

/// Drop the oldest entries beyond [`HISTORY_CAP`], newest last. Every
/// retained entry keeps its own complete state, so compaction cannot
/// change what any surviving entry restores to, and it cannot change what
/// the image renders as at all.
pub fn compact_history(mut entries: Vec<HistoryEntry>) -> Vec<HistoryEntry> {
    if entries.len() > HISTORY_CAP {
        entries.drain(..entries.len() - HISTORY_CAP);
    }
    entries
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    Variants,
    Snapshots,
    History,
}

impl Block {
    fn container(self) -> &'static str {
        match self {
            Block::Variants => VARIANTS_CONTAINER,
            Block::Snapshots => SNAPSHOTS_CONTAINER,
            Block::History => HISTORY_CONTAINER,
        }
    }
}

/// An entry whose `rdf:Description` is open but not yet closed.
struct InProgressEntry {
    /// `papp:VariantId` / `papp:SnapshotName` / `papp:HistoryKind`.
    first: String,
    /// `papp:VariantName` / `papp:SnapshotCreated` / `papp:HistoryDescription`.
    second: String,
    /// `papp:VariantCreated` / — / `papp:HistoryTime`.
    third: String,
    deleted: bool,
    model: AdjustmentModel,
    curves: CurveWalker,
}

/// Incremental state for the three nested blocks, driven by
/// [`super::parse_document`] exactly like the tone-curve and
/// local-adjustments walkers beside it.
#[derive(Default)]
pub(super) struct VariantsWalker {
    block: Option<Block>,
    in_seq: bool,
    in_li: bool,
    entry: Option<InProgressEntry>,
    out: Variants,
}

impl VariantsWalker {
    /// Handle an element opening. `true` means the element belongs to one
    /// of the three blocks and the caller must skip its flat attribute
    /// walk — an entry's state attributes are the entry's, not the
    /// document's, and letting them reach the document model would apply a
    /// history entry's exposure to the live image.
    pub(super) fn start(&mut self, name: &str, e: &BytesStart<'_>) -> Result<bool> {
        let Some(block) = self.block else {
            self.block = match name {
                VARIANTS_CONTAINER => Some(Block::Variants),
                SNAPSHOTS_CONTAINER => Some(Block::Snapshots),
                HISTORY_CONTAINER => Some(Block::History),
                _ => None,
            };
            return Ok(self.block.is_some());
        };
        if let Some(entry) = self.entry.as_mut() {
            // Inside an entry the only structured content is a point tone
            // curve; anything else is swallowed rather than modelled.
            entry.curves.start(name);
            return Ok(true);
        }
        if !self.in_seq && is_seq(name) {
            self.in_seq = true;
        } else if self.in_seq && !self.in_li && is_li(name) {
            self.in_li = true;
        } else if self.in_li && is_description(name) {
            self.entry = Some(read_entry(block, e)?);
        }
        Ok(true)
    }

    /// Handle a self-closing element. Maple's own writer emits an entry
    /// with no tone curves as a self-closing `rdf:Description`, which
    /// arrives here rather than through [`Self::start`].
    pub(super) fn empty(&mut self, name: &str, e: &BytesStart<'_>) -> Result<bool> {
        let Some(block) = self.block else {
            return Ok(false);
        };
        if self.entry.is_none() && self.in_li && is_description(name) {
            let entry = read_entry(block, e)?;
            self.commit(block, entry);
        }
        Ok(true)
    }

    /// Accumulate text while inside an entry — tone-curve `rdf:li` bodies.
    pub(super) fn text(&mut self, chunk: &str) {
        if let Some(entry) = self.entry.as_mut() {
            entry.curves.text(chunk);
        }
    }

    /// Handle an element closing, committing the finished entry when its
    /// `rdf:Description` ends.
    pub(super) fn end(&mut self, name: &str) {
        let Some(block) = self.block else { return };
        if let Some(mut entry) = self.entry.take() {
            entry.curves.end(name, &mut entry.model);
            if is_description(name) {
                self.commit(block, entry);
            } else {
                self.entry = Some(entry);
            }
            return;
        }
        if self.in_li {
            if is_li(name) {
                self.in_li = false;
            }
        } else if self.in_seq {
            if is_seq(name) {
                self.in_seq = false;
            }
        } else if name == block.container() {
            self.block = None;
        }
    }

    fn commit(&mut self, block: Block, entry: InProgressEntry) {
        match block {
            Block::Variants => {
                if is_valid_variant_id(&entry.first) {
                    self.out.variants.push(VariantRecord {
                        id: entry.first,
                        name: entry.second,
                        created: entry.third,
                        deleted: entry.deleted,
                    });
                }
            }
            Block::Snapshots => self.out.snapshots.push(Snapshot {
                name: entry.first,
                created: entry.second,
                model: entry.model,
            }),
            Block::History => self.out.history.push(HistoryEntry {
                kind: entry.first,
                description: entry.second,
                time: entry.third,
                model: entry.model,
            }),
        }
    }

    /// Record `papp:VariantId` / `papp:VariantName` seen as flat
    /// attributes on the document's own `rdf:Description`. Returns `true`
    /// when the key was one of those two, so the caller can skip it.
    pub(super) fn document_attribute(&mut self, key: &str, value: &str) -> bool {
        match key {
            "papp:VariantId" => self.out.variant_id = value.to_string(),
            "papp:VariantName" => self.out.variant_name = value.to_string(),
            _ => return false,
        }
        true
    }

    /// Consume the walker. `stamp` is the document's resolved WB slider
    /// scale: an entry's state was authored in the same scale as the
    /// document that carries it, so it inherits the same reading rather
    /// than defaulting to the modern one (#1780).
    pub(super) fn finish(mut self, stamp: super::WbScaleVersion) -> Variants {
        for snapshot in &mut self.out.snapshots {
            snapshot.model.wb_scale_version = stamp;
        }
        for entry in &mut self.out.history {
            entry.model.wb_scale_version = stamp;
        }
        self.out.history = compact_history(std::mem::take(&mut self.out.history));
        self.out
    }
}

/// Read one entry's `rdf:Description` attributes: the block's own metadata
/// keys into the entry header, everything else through the ordinary
/// schema mapping into the entry's model.
fn read_entry(block: Block, e: &BytesStart<'_>) -> Result<InProgressEntry> {
    let mut entry = InProgressEntry {
        first: String::new(),
        second: String::new(),
        third: String::new(),
        deleted: false,
        model: AdjustmentModel::default(),
        curves: CurveWalker::default(),
    };
    // Crop gating needs the whole attribute set before any `crs:Crop*`
    // value is applied, exactly as the document-level walk does.
    let mut has_crop = false;
    for attr in e.attributes() {
        let attr = attr.map_err(|e| Error::Xmp(e.to_string()))?;
        let key = std::str::from_utf8(attr.key.as_ref()).map_err(|e| Error::Xmp(e.to_string()))?;
        if key == "crs:HasCrop" {
            let value = attr
                .unescape_value()
                .map_err(|e| Error::Xmp(e.to_string()))?;
            has_crop = matches!(value.as_ref(), "True" | "true");
        }
    }
    let mut sigma_seen = false;
    let mut profile_seen = false;
    for attr in e.attributes() {
        let attr = attr.map_err(|e| Error::Xmp(e.to_string()))?;
        let key = std::str::from_utf8(attr.key.as_ref()).map_err(|e| Error::Xmp(e.to_string()))?;
        let value = attr
            .unescape_value()
            .map_err(|e| Error::Xmp(e.to_string()))?;
        let header = match (block, key) {
            (Block::Variants, "papp:VariantId") | (Block::Snapshots, "papp:SnapshotName") => {
                entry.first = value.to_string();
                true
            }
            (Block::History, "papp:HistoryKind") => {
                entry.first = value.to_string();
                true
            }
            (Block::Variants, "papp:VariantName") | (Block::Snapshots, "papp:SnapshotCreated") => {
                entry.second = value.to_string();
                true
            }
            (Block::History, "papp:HistoryDescription") => {
                entry.second = value.to_string();
                true
            }
            (Block::Variants, "papp:VariantCreated") | (Block::History, "papp:HistoryTime") => {
                entry.third = value.to_string();
                true
            }
            (Block::Variants, "papp:VariantDeleted") => {
                entry.deleted = super::parse_xmp_bool(&value).unwrap_or(false);
                true
            }
            _ => false,
        };
        if !header {
            set_field(
                &mut entry.model,
                key,
                &value,
                &mut sigma_seen,
                &mut profile_seen,
                has_crop,
            )?;
        }
    }
    Ok(entry)
}
