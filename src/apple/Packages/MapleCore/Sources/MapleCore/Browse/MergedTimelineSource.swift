// Sources/MapleCore/Browse/MergedTimelineSource.swift
//
// Pure merge logic that unions a PhotoKit-local stream of assets with a
// Cloud stream and emits per-cell badges:
//   - .synced     — same content present in both streams (open from local)
//   - .cloudOnly  — present only in cloud (e.g. deleted from Apple Photos
//                   but kept in the cloud library)
//   - .localOnly  — present only in PhotoKit (e.g. not yet backed up)
//
// No I/O. Browse view-models call `merge(local:cloud:)` with the two lists
// already fetched from their sources. Cell ordering is capture-date
// descending.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §12.

import Foundation

public enum MergedTimelineCell: Sendable, Hashable {
    case localOnly(ImageRef)
    case cloudOnly(ImageRef)
    case synced(local: ImageRef, cloud: ImageRef)
}

public enum MergedTimelineSource {

    /// Unions the two streams and emits cells in capture-date-descending order.
    ///
    /// Join keys, in priority order:
    ///   1. `cloudIdentifier` — `PHCloudIdentifier.stringValue`, stable
    ///      across every device on the same iCloud Photos account. The
    ///      authoritative cross-device match.
    ///   2. `phassetLink` / `id` — `PHAsset.localIdentifier`, per-device.
    ///      Fallback for assets without a cloud id (local-only PhotoKit
    ///      libraries, pre-v2 cache rows).
    ///
    /// The cloud-side ref carries arrays of every link's local id + cloud id
    /// (`allPhassetLinks`, `allCloudIdentifiers`) so every device that has
    /// ever uploaded the same content gets a chance to match — not just the
    /// first entry in `phasset_links`.
    public static func merge(local: [ImageRef], cloud: [ImageRef]) -> [MergedTimelineCell] {
        var matchedLocalKeys = Set<String>()
        var cells: [MergedTimelineCell] = []
        cells.reserveCapacity(local.count + cloud.count)

        // Build the two lookup maps off the local stream. The cloudIdentifier
        // map is preferred; the phid map is the fallback. Local refs can
        // appear in both maps when both keys are known. Duplicates within
        // either map keep the first occurrence (stable).
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

        // Walk the cloud stream. For each row, attempt cloud-id match first,
        // then fall back to phid. A multi-device cloud row may carry several
        // (phid, cloud_id) pairs in `allPhassetLinks` / `allCloudIdentifiers`;
        // any one matching wins.
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

    /// Probe cloud-id matches first across every cloud_id this row carries,
    /// then phid matches across every phid. Returns the first hit found.
    /// Pure helper; carved out to keep `merge` readable.
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
