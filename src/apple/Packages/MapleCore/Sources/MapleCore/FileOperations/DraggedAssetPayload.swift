// DraggedAssetPayload.swift — the `Transferable` payload carried by a
// grid-to-source-tree drag (#2646). Net new: this is the first
// `.draggable`/`.dropDestination` usage anywhere in the SwiftUI app (see
// the ticket's grep of `.draggable`/`.dropDestination`/`NSItemProvider`
// across `src/apple/Maple/Views` — zero matches before this file).
//
// Carries the dragged selection's `AssetRef.ID`s (UUIDs) as a
// comma-joined string via `ProxyRepresentation` over `String`'s own
// built-in `.plainText` transfer representation — no custom `UTType`
// declaration needed (this payload never needs to interop with another
// app or Finder; it only ever round-trips within this process, from a
// `PhotoThumbnailCell`'s `.draggable` to a source-tree row's
// `.dropDestination`).
//
// Lives in MapleCore (alongside `AssetRef` itself) rather than the app
// target so the drop-target routing in `AppShell+AssetDrop.swift` can
// decode it without a SwiftUI import — `Transferable` comes from
// `CoreTransferable`, a system framework with no SwiftUI dependency.

import CoreTransferable
import Foundation

/// The whole dragged selection, in original grid order. Per the design
/// doc's "Move / copy via drag-and-drop" section: "multi-select drag
/// carries the whole selection if the dragged item is part of it" — the
/// grid decides which IDs to include (either just the one tile, or the
/// full `selectedIDs` set) before constructing this payload; this type
/// itself is just the carrier.
public struct DraggedAssetPayload: Transferable, Equatable, Sendable {
    public let ids: [AssetRef.ID]

    public init(ids: [AssetRef.ID]) {
        self.ids = ids
    }

    public static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation(exporting: \.encoded, importing: DraggedAssetPayload.init(encoded:))
    }

    // `internal`, not `private`, so the round-trip these two halves form is
    // reachable from the test target — a test that re-implements the
    // comma-join instead of calling them proves nothing about this type.
    var encoded: String {
        ids.map(\.uuidString).joined(separator: ",")
    }

    init(encoded: String) {
        self.ids = encoded
            .split(separator: ",")
            .compactMap { UUID(uuidString: String($0)) }
    }

    /// Count badge text for the drag preview (#2779) — "N Photos", shown
    /// only when the payload carries more than one asset (the caller
    /// overlays this on the thumbnail; a single-asset drag shows the bare
    /// thumbnail, no badge). Pure and platform-independent so it's testable
    /// without SwiftUI — the preview VIEW itself (thumbnail + overlay
    /// layout) is not unit-testable and isn't covered here.
    public var previewBadgeText: String {
        Self.previewBadgeText(forCount: ids.count)
    }

    /// Same text, addressable by a bare count — lets the drag-preview view
    /// (`AssetDragPreview`, Maple app target) derive the badge string
    /// without constructing a throwaway payload.
    public static func previewBadgeText(forCount count: Int) -> String {
        count == 1 ? "1 Photo" : "\(count) Photos"
    }
}
