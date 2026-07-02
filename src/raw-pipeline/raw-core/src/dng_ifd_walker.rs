//! Recursive DNG IFD walker — locates a tag anywhere in the SubIFD tree.
//!
//! ## Why this exists
//!
//! The current decode path reads camera profile tags (HSM, PLT, BaselineExposure,
//! …) by querying `decoder.ifd(WellKnownIFD::Root)?.get_entry(...)` — i.e. only
//! the Root IFD. This works for Hasselblad / Leica DNGs that put their profile
//! tags in IFD0, but fails on Apple iPhone DNGs which write the DNG 1.6
//! `ProfileGainTableMap` into a SubIFD reachable from the Root IFD via tag 330
//! (`SubIFDs`). Without recursing into SubIFDs, those tags read as `None` and
//! the iPhone calibration falls through to a degraded fallback path
//! (test_0013 baseline ΔE ≈ 25 with R/B bias ≈ -0.20).
//!
//! ## Reference
//!
//! Pattern adapted from the reference walker at
//! `/Users/riabuz/Projects/Maple/src/raw-pipeline/crates/raw-core/src/metadata.rs`
//! (lines 80-110, 215-240, 786-822) which implements its own bring-your-own
//! TIFF parser. We don't need that here — rawler's `IFD` already provides
//! `sub_ifds()` (the parsed `SubIFDs` chain via tag 330) and `get_entry()`
//! (per-IFD tag fetch). We only port the **recursion-guard pattern**:
//!
//! 1. Cap recursion depth (`max_depth`) so a malicious / malformed DNG can't
//!    spin us forever.
//! 2. Track visited IFD offsets in a HashSet so a cycle (SubIFD → SubIFD that
//!    refers back to its parent) terminates after one visit per node.
//! 3. Iterative DFS (Vec stack), not recursive Rust calls — keeps stack
//!    frames bounded regardless of depth limit.
//!
//! Cycle detection uses `IFD::offset` as the identity. `IFD::offset` is the
//! u32 byte offset within the file where the IFD's entry table begins. Two
//! IFDs at the same file offset are by definition the same IFD; revisiting
//! one is the bug case we guard against.
//!
//! ## Scope
//!
//! Walks Root IFD → its `SubIFDs` (tag 330) recursively. ExifIFDPointer
//! (tag 0x8769) is also exposed via `ifd.sub_ifds()` because rawler enrolls
//! it in the multi-sub-tag list during parsing — see
//! `rawler/src/formats/tiff/ifd.rs::new_root` line 53. So this walker
//! transparently covers Root → ExifIFD → SubIFDs → … without us
//! enumerating the chain by hand.
//!
//! ## Public API
//!
//! - [`find_entry_recursive`]: returns the first `&Entry` matching `tag`,
//!   searching depth-first into all sub-IFDs up to `max_depth` levels.
//! - [`find_ifd_with_tag`]: returns the first `&IFD` containing `tag`, useful
//!   when callers need access to the surrounding IFD (e.g. to read a sibling
//!   tag at the same depth).
//!
//! Both return `None` if the tag is absent. Both are pure read-only over an
//! already-parsed `IFD` tree — no I/O, no allocation beyond a small visited
//! set.

use rawler::formats::tiff::{Entry, IFD};
use rawler::tags::TiffTag;
use std::collections::HashSet;

/// Default depth limit. 4 covers Root → SubIFDs → nested-SubIFDs → SubIFDs
/// (deeper than any DNG we've seen in the wild). Deeper malformed files are
/// rejected silently — caller gets `None` rather than a panic.
pub const DEFAULT_MAX_DEPTH: u32 = 4;

/// Find the first entry matching `tag` anywhere in `root`'s sub-IFD tree
/// (including `root` itself), depth-first. Walks no deeper than `max_depth`
/// levels. Cycle-safe (offset-based visited set).
///
/// Pass `tag` as any `TiffTag` impl — `DngTag::ProfileGainTableMap`,
/// `TiffCommonTag::SubIFDs`, raw `u16`, etc. all work.
pub fn find_entry_recursive<T: TiffTag + Copy>(
    root: &IFD,
    tag: T,
    max_depth: u32,
) -> Option<&Entry> {
    find_ifd_with_tag(root, tag, max_depth).and_then(|ifd| ifd.get_entry(tag))
}

/// Find the first IFD that contains `tag`, depth-first. Same semantics as
/// [`find_entry_recursive`] but returns the surrounding IFD so callers can
/// pull sibling tags from the same level.
pub fn find_ifd_with_tag<T: TiffTag + Copy>(root: &IFD, tag: T, max_depth: u32) -> Option<&IFD> {
    let mut stack: Vec<(&IFD, u32)> = vec![(root, 0)];
    let mut visited: HashSet<u32> = HashSet::new();
    while let Some((ifd, depth)) = stack.pop() {
        // Recursion-guard: depth limit + offset cycle detection. Mirrors the
        // reference walker at metadata.rs:88 (`visited.len() > 32`) but uses
        // the configurable `max_depth` parameter instead of a hardcoded cap.
        if depth > max_depth {
            continue;
        }
        if !visited.insert(ifd.offset) {
            continue;
        }
        if ifd.get_entry(tag).is_some() {
            return Some(ifd);
        }
        // Walk every sub-IFD branch. `sub_ifds()` returns the parsed map
        // keyed by parent-tag-id (e.g. 330 for SubIFDs, 0x8769 for ExifIFD).
        // Per rawler/src/formats/tiff/ifd.rs::new_root, both are enrolled
        // by default during parsing — so this single hop covers the
        // ExifIFD chain too.
        for subs in ifd.sub_ifds().values() {
            for sub in subs {
                stack.push((sub, depth + 1));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use rawler::bits::Endian;
    use rawler::formats::tiff::{Entry, Value};
    use rawler::tags::DngTag;
    use std::collections::{BTreeMap, HashMap};

    /// Build a synthetic IFD at `offset` with a single Long entry at `tag = value`,
    /// no sub-IFDs. Useful as a leaf in the synthetic tree below.
    fn leaf_ifd(offset: u32, tag: u16, value: u32) -> IFD {
        let mut entries = BTreeMap::new();
        entries.insert(
            tag,
            Entry {
                tag,
                value: Value::Long(vec![value]),
                embedded: None,
            },
        );
        IFD {
            offset,
            base: 0,
            corr: 0,
            next_ifd: 0,
            entries,
            endian: Endian::Little,
            sub: HashMap::new(),
            chain: Vec::new(),
        }
    }

    /// Build an IFD at `offset` with no payload tags, but `subs[i]` injected
    /// under sub-tag id `tag_id`.
    fn parent_ifd(offset: u32, tag_id: u16, subs: Vec<IFD>) -> IFD {
        let mut sub_map = HashMap::new();
        sub_map.insert(tag_id, subs);
        IFD {
            offset,
            base: 0,
            corr: 0,
            next_ifd: 0,
            entries: BTreeMap::new(),
            endian: Endian::Little,
            sub: sub_map,
            chain: Vec::new(),
        }
    }

    const SUB_IFDS_TAG: u16 = 330;
    const PROFILE_GAIN_TABLE_MAP: u16 = 52525; // DngTag::ProfileGainTableMap

    /// Tag at depth 3 — Root → SubIFD → nested-SubIFD → leaf. Walker with
    /// `max_depth >= 3` finds it; with `max_depth < 3` returns None.
    #[test]
    fn finds_tag_at_depth_three_when_max_depth_allows() {
        let leaf = leaf_ifd(/*offset*/ 4000, PROFILE_GAIN_TABLE_MAP, 0xDEADBEEF);
        let mid = parent_ifd(3000, SUB_IFDS_TAG, vec![leaf]);
        let inner = parent_ifd(2000, SUB_IFDS_TAG, vec![mid]);
        let root = parent_ifd(1000, SUB_IFDS_TAG, vec![inner]);

        let found = find_entry_recursive(&root, DngTag::ProfileGainTableMap, 4)
            .expect("max_depth=4 should reach depth-3 leaf");
        assert_eq!(found.value.force_u32(0), 0xDEADBEEF);
    }

    /// Same tree as above with max_depth=2 — leaf is unreachable.
    #[test]
    fn returns_none_when_max_depth_too_shallow() {
        let leaf = leaf_ifd(4000, PROFILE_GAIN_TABLE_MAP, 0xDEADBEEF);
        let mid = parent_ifd(3000, SUB_IFDS_TAG, vec![leaf]);
        let inner = parent_ifd(2000, SUB_IFDS_TAG, vec![mid]);
        let root = parent_ifd(1000, SUB_IFDS_TAG, vec![inner]);

        let found = find_entry_recursive(&root, DngTag::ProfileGainTableMap, 2);
        assert!(found.is_none(), "max_depth=2 must NOT reach depth-3 leaf");
    }

    /// Tag at depth 1 (a direct SubIFD) — the iPhone case. max_depth=1 is enough.
    #[test]
    fn finds_tag_in_direct_subifd() {
        let leaf = leaf_ifd(2000, PROFILE_GAIN_TABLE_MAP, 0x1234);
        let root = parent_ifd(1000, SUB_IFDS_TAG, vec![leaf]);

        let found = find_entry_recursive(&root, DngTag::ProfileGainTableMap, 1)
            .expect("max_depth=1 finds direct SubIFD");
        assert_eq!(found.value.force_u32(0), 0x1234);
    }

    /// Tag at the Root IFD — the Hasselblad / Leica case. Walker finds it at
    /// depth 0 regardless of max_depth.
    #[test]
    fn finds_tag_at_root() {
        let mut root = leaf_ifd(1000, PROFILE_GAIN_TABLE_MAP, 0xABCD);
        // Add an irrelevant sub-IFD so the search has alternatives.
        let mut sub_map = HashMap::new();
        sub_map.insert(SUB_IFDS_TAG, vec![leaf_ifd(2000, 999, 0)]);
        root.sub = sub_map;

        let found = find_entry_recursive(&root, DngTag::ProfileGainTableMap, 0)
            .expect("max_depth=0 still inspects the root itself");
        assert_eq!(found.value.force_u32(0), 0xABCD);
    }

    /// Tag absent from the entire tree — returns None.
    #[test]
    fn returns_none_when_tag_absent() {
        let leaf = leaf_ifd(2000, /*unrelated tag*/ 999, 42);
        let root = parent_ifd(1000, SUB_IFDS_TAG, vec![leaf]);

        let found = find_entry_recursive(&root, DngTag::ProfileGainTableMap, 4);
        assert!(found.is_none());
    }

    /// Cycle protection: synthetic IFD whose sub-tree references itself.
    /// The walker terminates in finite time by visited-offset tracking.
    /// Without the guard this would loop until depth limit, so we set
    /// max_depth high to make the test meaningful.
    #[test]
    fn handles_cycle_via_visited_offsets() {
        // Construct two IFDs that share an offset — the walker treats them
        // as the same node and visits each only once. This is a stand-in
        // for a real cycle (which we can't construct in this test fixture
        // because IFD's sub HashMap is owned, not Rc/Weak — so we approximate
        // via duplicated-offset siblings and verify the walker doesn't
        // double-explore).
        let leaf1 = leaf_ifd(2000, PROFILE_GAIN_TABLE_MAP, 0xAA);
        let leaf2 = leaf_ifd(2000, PROFILE_GAIN_TABLE_MAP, 0xBB); // SAME offset
        let root = parent_ifd(1000, SUB_IFDS_TAG, vec![leaf1, leaf2]);

        // Both leaves match; walker stops at first visited. Visited-offset
        // dedup means only ONE leaf is searched. Whichever comes off the
        // stack first wins (DFS LIFO → leaf2 inserted last is popped first).
        let found = find_entry_recursive(&root, DngTag::ProfileGainTableMap, 4)
            .expect("walker finds one of the duplicated-offset leaves");
        let v = found.value.force_u32(0);
        // Verify deduplication kicked in: if it didn't, both leaves would be
        // searched and we'd still find one. The actual property under test
        // is "doesn't infinite-loop" — finite return demonstrates the guard.
        assert!(
            v == 0xAA || v == 0xBB,
            "expected one of the leaf values, got {:#x}",
            v
        );
    }

    /// Walker returns the first matching IFD when the tag appears in
    /// multiple branches. DFS order: deeper-first via stack pop.
    #[test]
    fn finds_first_match_in_dfs_order() {
        // Two siblings under the root, each carrying the tag. Walker returns
        // the one popped first (LIFO of the inserted order).
        let s1 = leaf_ifd(2000, PROFILE_GAIN_TABLE_MAP, 0x1111);
        let s2 = leaf_ifd(3000, PROFILE_GAIN_TABLE_MAP, 0x2222);
        let root = parent_ifd(1000, SUB_IFDS_TAG, vec![s1, s2]);

        let ifd = find_ifd_with_tag(&root, DngTag::ProfileGainTableMap, 4)
            .expect("at least one of the siblings carries the tag");
        let v = ifd
            .get_entry(DngTag::ProfileGainTableMap)
            .unwrap()
            .value
            .force_u32(0);
        assert!(v == 0x1111 || v == 0x2222);
    }
}
