// CloudTimelineView+VM.swift — Pure-function view-model helpers for CloudTimelineView.
//
// Co-located sibling of CloudTimelineView.swift. Holds derivations and formatters
// that take typed inputs and return typed outputs — no SwiftUI, no @State, no
// view-builder closures. The view file calls these helpers and feeds the
// returned strings/structs into its body + tap-callback closures.
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation gets
// a sibling `+VM.swift` whose contents are unit-testable in isolation. To
// preserve that guarantee this file MUST NOT `import SwiftUI` — a grep gate
// in CI enforces it. If a helper needs `View` context it doesn't belong here.

import Foundation
import MapleCore

// MARK: - CloudTimelineViewVM

/// Namespace for pure CloudTimelineView derivations. A caseless enum keeps
/// the helpers grouped without ever being instantiated. All members are
/// static.
enum CloudTimelineViewVM {

    // MARK: - Layout constants

    /// Column count for the per-month LazyVGrid. Mirrors BrowseGrid's
    /// timeline density. Surfaced here so a future "compact / dense"
    /// toggle has one place to read from.
    static let columnCount: Int = 4

    // MARK: - Bucket identity

    /// Stable identity for SwiftUI `ForEach(... id: ...)` over month
    /// buckets — "2026-05". Used in two places: the `ForEach` id selector
    /// AND the `.task(id:)` modifier on the section view, so the same
    /// string drives both identity and task restarts.
    static func bucketKey(year: Int, month: Int) -> String {
        "\(year)-\(month)"
    }

    // MARK: - Month header

    /// Human-readable month label for a section header — "May 2026". Uses
    /// the en_US_POSIX locale so the label is stable across user locales
    /// (the timeline is index-style chrome, not user-facing prose). Falls
    /// back to "YYYY-MM" if `DateComponents` somehow can't materialise a
    /// `Date` (defensive — should be unreachable for any valid month).
    static func monthLabel(year: Int, month: Int) -> String {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = 1
        if let date = monthLabelCalendar.date(from: components) {
            return monthLabelFormatter.string(from: date)
        }
        return "\(year)-\(String(format: "%02d", month))"
    }

    /// Process-wide cached formatter — `monthLabel` is hit once per
    /// visible MonthSection per body recompute, which during a Timeline
    /// scroll fires often. Allocating a fresh DateFormatter per hit was
    /// showing up as measurable overhead during fast scrolls.
    private static let monthLabelFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "MMMM yyyy"
        return f
    }()

    /// Paired with `monthLabelFormatter` — explicit gregorian calendar so
    /// `DateComponents(year:month:day:)` resolves the same way regardless
    /// of the user's locale calendar.
    private static let monthLabelCalendar = Calendar(identifier: .gregorian)

    // MARK: - Content gating

    /// True when the section has something to render — merged cells when
    /// the VM produced a merge, raw cloud assets otherwise. Drives the
    /// "no results" inline label vs the grid.
    static func hasContent(assets: [SearchAsset], mergedCells: [MergedTimelineCell]?) -> Bool {
        if let merged = mergedCells { return !merged.isEmpty }
        return !assets.isEmpty
    }

    // MARK: - Abs-path routing for merged cells

    /// Strips the "fs:" prefix the cloud uses on its IDs to expose the
    /// underlying absolute path. Cloud IDs are shaped `"fs:<abs_path>"`
    /// in the merged-timeline / cloud-search contract; the bare path is
    /// the key into `absPathMap(from:)` and the only stable handle the
    /// merged cell carries back to a `SearchAsset`.
    static func absPath(fromCloudID id: String) -> String {
        id.hasPrefix("fs:") ? String(id.dropFirst(3)) : id
    }

    /// Builds an `abs_path → SearchAsset` lookup so each merged cell can
    /// resolve its cloud-side asset by id. Built once per section render
    /// rather than per-cell. On duplicate keys the first wins — the
    /// server's search responses are de-duplicated at the abs_path level
    /// but the keep-first policy is defensive.
    static func absPathMap(from assets: [SearchAsset]) -> [String: SearchAsset] {
        Dictionary(assets.map { ($0.abs_path, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// Encoded tap-target decision for a merged cell — keeps the routing
    /// branch pure so the view's `onSelect` closure becomes a thin
    /// switch over this enum. `.cloud(asset)` means "open via
    /// onSelectAsset"; `.local(ref)` means "open the PhotoKit asset
    /// directly via onSelectLocalAsset"; `.none` means we couldn't find
    /// the cloud-side asset (e.g. the search response lost the row
    /// between bucket count and page fetch).
    enum MergedSelectionTarget {
        case cloud(SearchAsset)
        case local(ImageRef)
        case none
    }

    /// Resolves which target a tap on a merged cell should route to. The
    /// view feeds `.cloud(asset)` into `onSelectAsset` and `.local(ref)`
    /// into `onSelectLocalAsset`; `.none` drops the tap (matches the
    /// pre-refactor behaviour — the `if let` simply didn't fire).
    static func selectionTarget(
        for cell: MergedTimelineCell,
        absPathMap: [String: SearchAsset]
    ) -> MergedSelectionTarget {
        switch cell {
        case .cloudOnly(let cloudRef), .synced(_, let cloudRef):
            let abs = absPath(fromCloudID: cloudRef.id)
            if let asset = absPathMap[abs] {
                return .cloud(asset)
            }
            return .none
        case .localOnly(let local):
            return .local(local)
        }
    }
}
