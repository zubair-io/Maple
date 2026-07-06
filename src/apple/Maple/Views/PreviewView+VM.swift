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
    /// than pushing the trailing controls off-screen. Mirrors the 200pt cap
    /// `PillHeader` already applies to the editor filename so the two headers
    /// look identical.
    static let filenameMaxWidth: CGFloat = 200

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

    // MARK: - Swipe gesture classification (spec §4)

    /// Classifies a completed drag translation into a prev/next step, or
    /// `nil` when the gesture doesn't qualify. Extracted so the ~40pt
    /// threshold + horizontal-dominance rule (|dx| > |dy|) are tested
    /// without a live gesture.
    ///
    /// A left drag (`dx < 0`) advances to the NEXT image (content moves left,
    /// revealing what's to the right — the standard photo-viewer convention);
    /// a right drag goes to the PREVIOUS image.
    enum SwipeStep: Equatable { case next, previous }

    static func swipeStep(
        dx: CGFloat,
        dy: CGFloat,
        threshold: CGFloat = 40
    ) -> SwipeStep? {
        guard abs(dx) >= threshold, abs(dx) > abs(dy) else { return nil }
        return dx < 0 ? .next : .previous
    }

    // MARK: - Image-source selection (spec §2)

    /// Which cached image PreviewView paints. The Preview display path is
    /// deliberately the SAME 256px thumbnail path the grid + filmstrip already
    /// use (`ThumbnailProvider` → `ThumbnailLoader.shared`), so opening a photo
    /// never boots the render pipeline. A dedicated 1280px "display preview"
    /// tier is spec §3 (slice A1) and does not exist on Apple yet — until it
    /// lands there is one tier, so `thumbnail` and `displayPreview` resolve to
    /// the same `ThumbnailSource`. Modelling the two stages explicitly (rather
    /// than collapsing them) keeps the swap seam ready for A1 to fill and keeps
    /// this selection unit-testable.
    ///
    /// Returns `.local(asset, source:)` for every asset — that case routes to
    /// `ThumbnailLoader.shared.load(for:from:)`, which itself dispatches on
    /// whether the asset has a `primaryURL` (filesystem) or is sourceless
    /// (PhotoKit / self-hosted, resolved via the threaded `source`). No new
    /// backend, no new cache.
    static func thumbnailSource(
        for asset: AssetRef,
        source: (any ImageSource)?
    ) -> ThumbnailSource {
        .local(asset, source: source.map(ImageSourceBox.init))
    }
}
