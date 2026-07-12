// PreviewView+VM.swift — pure-function view-model helpers for PreviewView.
//
// Co-located sibling of PreviewView.swift (the fast static-image Preview
// surface inserted between the grid and the editor — Fast Preview epic,
// design doc 2026-07-06-fast-preview-and-phone-card-editor-design.md §4).
//
// Pattern (issue #192): every SwiftUI view with non-trivial derivation gets a
// sibling `+VM.swift` whose contents are unit-testable in isolation. To
// preserve that guarantee this file MUST NOT `import SwiftUI` — a grep gate in
// CI enforces it. If a helper needs `View` context it doesn't belong here.
//
// `CoreGraphics` is fine for `CGFloat` (the header max-width token) — a pure
// value type from Foundation's sibling framework with no UI dependency.

import CoreGraphics
import Foundation
import MapleCore

// MARK: - PreviewViewVM

/// Namespace for pure PreviewView derivations. A caseless enum keeps the
/// helpers grouped without ever being instantiated. All members are static.
enum PreviewViewVM {

    // MARK: - Header max-width (spec §6)

    /// Filename max-width cap for the Preview / Editor header, in points. A
    /// pathologically long filename truncates (middle) at this width rather
    /// than pushing the trailing controls off-screen.
    ///
    /// Responsive, mirroring the Web fix's `min(200px, 40vw)`: on the compact
    /// size class (a ~375–430pt iPhone) the pill also carries ~5 icon buttons,
    /// so a flat 200pt name could still crowd them — cap tighter at 150pt. On
    /// regular (iPad / Mac) the pill has room, so the full 200pt ceiling
    /// applies. Used by both `PillHeader` (editor) and `PreviewView`'s header
    /// so the two truncate identically at each width class.
    ///
    /// A size-class step (rather than a `GeometryReader`-measured `width * 0.5`)
    /// is deliberate: the editor pill hugs its content via `fixedSize`, so
    /// measuring its own width to cap a child inside it would be circular. The
    /// two-step cap gives the same "can't crowd a narrow phone" guarantee
    /// without that layout hazard.
    static func filenameMaxWidth(isCompact: Bool) -> CGFloat {
        isCompact ? 150 : 200
    }

    // MARK: - Prev/next image navigation (spec §4)

    /// The asset that follows `currentID` in `orderedIDs`, for a
    /// right-swipe / → key. Returns `nil` when navigation is impossible
    /// (empty list, or `currentID` not present so there's no anchor).
    ///
    /// When `wraps` is true (the spec's "wraps selection through
    /// `assetsInSelectedFolder()`" behaviour) stepping off the end returns
    /// the first element; when false the last element returns `nil` so the
    /// caller can no-op at the boundary.
    ///
    /// Pure over `(currentID, orderedIDs)` — no `BrowseViewModel` needed — so
    /// the wrap/clamp edge cases are unit-testable without a live VM. The view
    /// feeds the returned id back into its selection + filmstrip state.
    static func nextID(
        after currentID: AssetRef.ID?,
        in orderedIDs: [AssetRef.ID],
        wraps: Bool = true
    ) -> AssetRef.ID? {
        guard let currentID, let idx = orderedIDs.firstIndex(of: currentID) else {
            // No anchor — but if there's exactly one place to go (a non-empty
            // list and no current selection), start at the front. Matches the
            // "select first when nothing is selected" convenience the grid VM
            // uses, without wrapping semantics leaking in.
            return currentID == nil ? orderedIDs.first : nil
        }
        let nextIdx = idx + 1
        if nextIdx < orderedIDs.count { return orderedIDs[nextIdx] }
        return wraps ? orderedIDs.first : nil
    }

    /// The asset that precedes `currentID` in `orderedIDs`, for a
    /// left-swipe / ← key. Mirror of `nextID(after:in:wraps:)`; stepping off
    /// the front wraps to the last element when `wraps` is true, else `nil`.
    static func previousID(
        before currentID: AssetRef.ID?,
        in orderedIDs: [AssetRef.ID],
        wraps: Bool = true
    ) -> AssetRef.ID? {
        guard let currentID, let idx = orderedIDs.firstIndex(of: currentID) else {
            return currentID == nil ? orderedIDs.last : nil
        }
        let prevIdx = idx - 1
        if prevIdx >= 0 { return orderedIDs[prevIdx] }
        return wraps ? orderedIDs.last : nil
    }

    // MARK: - Image-source selection (spec §2)

    /// Which cached image PreviewView paints. The Preview display path is
    /// deliberately the SAME 256px thumbnail path the grid + filmstrip already
    /// use (`ThumbnailProvider` → `ThumbnailLoader.shared`), so opening a photo
    /// never boots the render pipeline. The display tier (spec §3, slice A1)
    /// rides the same `ThumbnailSource`: `ThumbnailProvider.preview` dispatches
    /// it per backend after the thumbnail paints (`.maple/previews` 1600 px for
    /// URL-backed local assets, `/api/fs/preview` for Maple Cloud sources,
    /// PHImageManager high-quality for PhotoKit).
    ///
    /// PhotoKit must route explicitly through `.photoKit`: its generic
    /// `ImageSource.preview(for:)` intentionally returns nil, while the app-side
    /// PhotoKit backend supports size-aware display and zoom refinement.
    /// Other sources retain the shared `.local`/ThumbnailLoader route.
    static func thumbnailSource(
        for asset: AssetRef,
        source: (any ImageSource)?
    ) -> ThumbnailSource {
        if asset.primaryURL == nil,
           source is PhotoKitSource,
           let localID = asset.stableID {
            return .photoKit(localID: localID)
        }
        return .local(asset, source: source.map(ImageSourceBox.init))
    }
}
