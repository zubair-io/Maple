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
    /// Match rule: a `cloud` row whose `phassetLink == local.id` is the same
    /// asset; emit as `.synced` (rendering uses the local thumb because it's
    /// instant).
    public static func merge(local: [ImageRef], cloud: [ImageRef]) -> [MergedTimelineCell] {
        var matchedLocalIDs = Set<String>()
        var cells: [MergedTimelineCell] = []
        cells.reserveCapacity(local.count + cloud.count)

        // First pass: walk cloud, attach a local match when found.
        let localByPHID: [String: ImageRef] = Dictionary(
            uniqueKeysWithValues: local.map { ($0.id, $0) })

        for c in cloud {
            if let phid = c.phassetLink, let l = localByPHID[phid] {
                cells.append(.synced(local: l, cloud: c))
                matchedLocalIDs.insert(phid)
            } else {
                cells.append(.cloudOnly(c))
            }
        }
        // Second pass: any local not matched is .localOnly.
        for l in local where !matchedLocalIDs.contains(l.id) {
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
