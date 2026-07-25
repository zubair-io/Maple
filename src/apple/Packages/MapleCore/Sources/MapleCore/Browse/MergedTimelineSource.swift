// Sources/MapleCore/Browse/MergedTimelineSource.swift
//
// Pure merge logic that unions any number of PhotoKit-local streams with any
// number of Cloud streams and emits per-cell badges:
//   - .synced     — same content present in at least one local stream and at
//                   least one cloud stream (open from local)
//   - .cloudOnly  — present only in one or more cloud streams (e.g. deleted
//                   from Apple Photos but kept in a cloud library)
//   - .localOnly  — present only in one or more local (PhotoKit) streams
//                   (e.g. not yet backed up)
//
// No I/O. Browse view-models call `merge(localStreams:cloudStreams:)` — or
// the pairwise `merge(local:cloud:)` convenience wrapper — with the lists
// already fetched from their sources. Cell ordering is capture-date
// descending.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §12.
// N-way generalization: #2272 — a unified timeline folding PhotoKit plus
// multiple cloud libraries (e.g. Self Hosted + Hosted) into one stream.

import Foundation

public enum MergedTimelineCell: Sendable, Hashable {
    case localOnly(ImageRef)
    case cloudOnly(ImageRef)
    case synced(local: ImageRef, cloud: ImageRef)
}

public enum MergedTimelineSource {

    /// Pairwise convenience wrapper over `merge(localStreams:cloudStreams:)`,
    /// kept so existing single-PhotoKit / single-cloud callers
    /// (`CloudTimelineViewModel`, `BrowseViewModel.reloadMerged`) don't need
    /// to wrap their two lists themselves. Behaviorally identical to calling
    /// the N-way function with one-element stream arrays.
    public static func merge(local: [ImageRef], cloud: [ImageRef]) -> [MergedTimelineCell] {
        merge(localStreams: [local], cloudStreams: [cloud])
    }

    /// Unions any number of local and cloud streams and emits cells in
    /// capture-date-descending order.
    ///
    /// Signature choice: a `(localStreams:cloudStreams:)` pair of arrays,
    /// not a single `merge(streams:)` taking source-kind-tagged elements.
    /// `MergedTimelineCell`'s classification is fundamentally binary — every
    /// cell is local-only, cloud-only, or both — mirroring how the rest of
    /// the backup model (`ImageRef.cloudIdentifier`/`phassetLink`, the
    /// PhotoKit-vs-cloud badge) already treats "local" and "cloud" as the
    /// two sides of one join, not N independent named sources. A two-array
    /// signature keeps that binary distinction explicit at the call site
    /// instead of pushing it into a per-item runtime tag, and it degrades to
    /// the existing pairwise call with a trivial single-element-array wrap.
    ///
    /// Join keys, in priority order:
    ///   1. `cloudIdentifier` — `PHCloudIdentifier.stringValue`, stable
    ///      across every device on the same iCloud Photos account. The
    ///      authoritative cross-device match.
    ///   2. `phassetLink` — `PHAsset.localIdentifier`, per-device. Fallback
    ///      for assets without a cloud id (local-only PhotoKit libraries,
    ///      pre-v2 cache rows).
    ///   3. `id` — plain identity equality. Last-resort fallback for streams
    ///      that carry neither a cloudIdentifier nor a phassetLink (e.g. two
    ///      cloud libraries whose rows both derive `id` from the same
    ///      content hash — see `ImageRef.id`'s doc comment).
    ///
    /// Each cloud-side ref carries arrays of every link's local id + cloud id
    /// (`allPhassetLinks`, `allCloudIdentifiers`) so every device/library
    /// that has ever uploaded the same content gets a chance to match — not
    /// just the first entry.
    ///
    /// Dedup scope: matches are only folded together *across* distinct
    /// streams. Two items within the very same stream that happen to share
    /// a join key are never collapsed into one cell — that mirrors the
    /// pre-N-way behavior (a single stream's duplicate rows already didn't
    /// collapse) and keeps a single malformed/duplicated source from ever
    /// hiding an entry.  The N-way capability this adds is: the *same*
    /// asset appearing in two different cloud libraries collapses to one
    /// `.cloudOnly`/`.synced` cell instead of one per library.
    public static func merge(
        localStreams: [[ImageRef]], cloudStreams: [[ImageRef]]
    ) -> [MergedTimelineCell] {
        let local = dedupedAcrossStreams(localStreams)
        let cloud = dedupedAcrossStreams(cloudStreams)

        var matchedLocalKeys = Set<String>()
        var cells: [MergedTimelineCell] = []
        cells.reserveCapacity(local.count + cloud.count)

        // Build the two lookup maps off the flattened local streams. The
        // cloudIdentifier map is preferred; the phid map is the fallback.
        // Local refs can appear in both maps when both keys are known.
        // Duplicates within either map keep the first occurrence (stable).
        var localByCloudID: [String: ImageRef] = [:]
        localByCloudID.reserveCapacity(local.count)
        var localByPHID: [String: ImageRef] = [:]
        localByPHID.reserveCapacity(local.count)
        for l in local {
            if let cid = l.cloudIdentifier, localByCloudID[cid] == nil {
                localByCloudID[cid] = l
            }
            if localByPHID[l.id] == nil {
                localByPHID[l.id] = l
            }
        }

        // Walk the deduped cloud stream. For each row, attempt cloud-id
        // match first, then phid, then plain id. A multi-device cloud row
        // may carry several (phid, cloud_id) pairs in `allPhassetLinks` /
        // `allCloudIdentifiers`; any one matching wins.
        for c in cloud {
            let match = findLocalMatch(
                for: c,
                byCloudID: localByCloudID,
                byPHID: localByPHID)
            if let local = match.local {
                cells.append(.synced(local: local, cloud: c))
                matchedLocalKeys.insert(local.id)
            } else {
                cells.append(.cloudOnly(c))
            }
        }
        // Second pass: any local not matched is .localOnly.
        for l in local where !matchedLocalKeys.contains(l.id) {
            cells.append(.localOnly(l))
        }

        // Sort by best-known capture date, descending. Cells without a date sink
        // to the bottom.
        return cells.sorted { lhs, rhs in
            let dl = bestCaptureDate(lhs) ?? .distantPast
            let dr = bestCaptureDate(rhs) ?? .distantPast
            return dl > dr
        }
    }

    /// Folds N streams into one deduped list, collapsing rows that share a
    /// join key (cloudIdentifier → phassetLink → id) *across* distinct
    /// streams — the first occurrence (in stream order) wins as the surviving
    /// representative, and it ABSORBS the join keys of every duplicate folded
    /// into it (union of `allCloudIdentifiers` / `allPhassetLinks`). Absorbing
    /// is load-bearing: a phassetLink or cloudIdentifier known only to a
    /// dropped library must survive on the representative, otherwise a local
    /// asset that would match only via that key fails to sync (spurious
    /// `.cloudOnly` + `.localOnly` instead of `.synced`). Rows within a single
    /// stream are never collapsed against each other; only a match against an
    /// *earlier* stream folds a row away. Used for both the cloud streams and
    /// the local (PhotoKit) streams.
    private static func dedupedAcrossStreams(_ streams: [[ImageRef]]) -> [ImageRef] {
        var reps: [ImageRef] = []
        var repByCloudID: [String: Int] = [:]  // committed keys → rep index
        var repByPHID: [String: Int] = [:]
        var repByID: [String: Int] = [:]  // keyless reps only

        for stream in streams {
            // Buffer this stream's genuinely-new reps and the key-absorptions
            // into earlier reps, then commit both to the cross-stream registry
            // only at the stream boundary — so two rows of the *same* stream
            // can never fold into one another (mirrors the pre-N-way pairwise
            // behavior), while a row that matches an *earlier* stream folds in.
            var newReps: [ImageRef] = []
            var absorb: [Int: (cloud: Set<String>, phid: Set<String>)] = [:]

            for c in stream {
                let (cloudIDs, phids) = joinKeys(of: c)
                // `id` is a LAST-RESORT key (see the ladder in the doc above):
                // consult it only for rows carrying neither a cloudIdentifier
                // nor a phassetLink, so a bare content-hash `id` collision can
                // never fold rows whose authoritative identity differs.
                let isKeyless = cloudIDs.isEmpty && phids.isEmpty
                let match =
                    cloudIDs.lazy.compactMap { repByCloudID[$0] }.first
                    ?? phids.lazy.compactMap { repByPHID[$0] }.first
                    ?? (isKeyless ? repByID[c.id] : nil)
                if let i = match {
                    // Fold `c` into its earlier-stream representative, but
                    // ABSORB its join keys so a phassetLink/cloudIdentifier
                    // known only to this dropped library isn't lost — a local
                    // that matches only via that key must still sync.
                    absorb[i, default: ([], [])].cloud.formUnion(cloudIDs)
                    absorb[i, default: ([], [])].phid.formUnion(phids)
                } else {
                    newReps.append(c)
                }
            }

            // Commit absorbed keys into the surviving reps (rebuilding their
            // key arrays) and into the registry.
            for (i, extra) in absorb {
                let (haveCloud, havePhid) = joinKeys(of: reps[i])
                let mergedCloud = orderedUnion(haveCloud, extra.cloud)
                let mergedPhid = orderedUnion(havePhid, extra.phid)
                reps[i] = withJoinKeys(reps[i], cloud: mergedCloud, phid: mergedPhid)
                for cid in extra.cloud where repByCloudID[cid] == nil { repByCloudID[cid] = i }
                for phid in extra.phid where repByPHID[phid] == nil { repByPHID[phid] = i }
            }
            // Commit this stream's new reps and register every key they carry.
            for c in newReps {
                let idx = reps.count
                reps.append(c)
                let (cloudIDs, phids) = joinKeys(of: c)
                for cid in cloudIDs where repByCloudID[cid] == nil { repByCloudID[cid] = idx }
                for phid in phids where repByPHID[phid] == nil { repByPHID[phid] = idx }
                if cloudIDs.isEmpty, phids.isEmpty, repByID[c.id] == nil { repByID[c.id] = idx }
            }
        }
        return reps
    }

    /// The cloud-id and phid join keys a row carries, each falling back from
    /// the `all*` array to the legacy singleton field.
    private static func joinKeys(of ref: ImageRef) -> (cloud: [String], phid: [String]) {
        let cloud = ref.allCloudIdentifiers ?? ref.cloudIdentifier.map { [$0] } ?? []
        let phid = ref.allPhassetLinks ?? ref.phassetLink.map { [$0] } ?? []
        return (cloud, phid)
    }

    /// `base` with every element of `add` not already present appended, sorted
    /// for deterministic output. Preserves `base` order (a survivor's own keys
    /// stay first).
    private static func orderedUnion(_ base: [String], _ add: Set<String>) -> [String] {
        base + add.subtracting(base).sorted()
    }

    /// A copy of `ref` with its join-key arrays replaced (empty → nil so the
    /// non-array fallbacks still apply). All other fields are preserved.
    private static func withJoinKeys(_ ref: ImageRef, cloud: [String], phid: [String]) -> ImageRef {
        ImageRef(
            id: ref.id, displayName: ref.displayName, url: ref.url,
            scopeParentURL: ref.scopeParentURL, captureDate: ref.captureDate,
            phassetLink: ref.phassetLink, cloudIdentifier: ref.cloudIdentifier,
            allPhassetLinks: phid.isEmpty ? nil : phid,
            allCloudIdentifiers: cloud.isEmpty ? nil : cloud)
    }

    /// Probe cloud-id matches first across every cloud_id this row carries,
    /// then phid matches across every phid, then plain id equality as a
    /// last resort. Returns the first hit found. Pure helper; carved out to
    /// keep `merge` readable.
    private static func findLocalMatch(
        for cloud: ImageRef,
        byCloudID: [String: ImageRef],
        byPHID: [String: ImageRef]
    ) -> (local: ImageRef?, key: String?) {
        // Cloud-id pass — every entry in allCloudIdentifiers, plus the
        // legacy single-cloudIdentifier field.
        let cloudIDs = cloud.allCloudIdentifiers ?? cloud.cloudIdentifier.map { [$0] } ?? []
        for cid in cloudIDs {
            if let local = byCloudID[cid] {
                return (local, cid)
            }
        }
        // Phid pass — every entry in allPhassetLinks, plus the legacy
        // single-phassetLink field.
        let phids = cloud.allPhassetLinks ?? cloud.phassetLink.map { [$0] } ?? []
        for phid in phids {
            if let local = byPHID[phid] {
                return (local, phid)
            }
        }
        // Id pass — LAST-RESORT plain identity equality, only for a cloud row
        // that carries neither a cloudIdentifier nor a phassetLink (honoring
        // the key priority documented above). `byPHID` is keyed on local `id`
        // (see the map build in `merge`), so a hit here means cloud.id ==
        // local.id. A cloud row that DOES carry a higher-priority key which
        // simply didn't match must not fall through to a bare-id match.
        if cloudIDs.isEmpty, phids.isEmpty, let local = byPHID[cloud.id] {
            return (local, cloud.id)
        }
        return (nil, nil)
    }

    /// The id used to render / open the cell — prefer the local-side id when
    /// synced, otherwise the cloud-side id.
    public static func renderID(_ cell: MergedTimelineCell) -> String {
        switch cell {
        case .localOnly(let r), .cloudOnly(let r): return r.id
        case .synced(let l, _): return l.id
        }
    }

    /// Best-effort capture date for ordering.
    public static func bestCaptureDate(_ cell: MergedTimelineCell) -> Date? {
        switch cell {
        case .localOnly(let r), .cloudOnly(let r): return r.captureDate
        case .synced(let l, let c): return l.captureDate ?? c.captureDate
        }
    }
}

// MARK: - MergedTimelineCell Identifiable (#1490 M1b)

/// `Identifiable` conformance so `MergedTimelineCell` can be used directly
/// as `PhotoGrid`'s `Element` type without a separate ForEach `id:` parameter.
/// Identity delegates to `MergedTimelineSource.renderID` — the same stable key
/// the original `ForEach(vm.mergedCells, id: \.self)` derived via Hashable.
extension MergedTimelineCell: Identifiable {
    public var id: String { MergedTimelineSource.renderID(self) }
}

extension MergedTimelineSource {
    /// Human-readable display name for a merged cell. Prefers the local ref
    /// for `.synced` (the PhotoKit name is what the user sees in Apple Photos).
    /// Used by `PhotoGridItem(merged:)` to populate `displayName` for the
    /// accessibility identifier on `PhotoThumbnailCell`.
    public static func displayName(_ cell: MergedTimelineCell) -> String {
        switch cell {
        case .localOnly(let r), .cloudOnly(let r): return r.displayName
        case .synced(let local, _): return local.displayName
        }
    }
}
