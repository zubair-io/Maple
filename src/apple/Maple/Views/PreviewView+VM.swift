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
    ///
    /// Routing is INTRINSIC to the asset first (#2299): `asset.
    /// thumbnailProvenance == .photoKit` routes to `.photoKit` regardless of
    /// what `source` happens to be. This is load-bearing for a MIXED list —
    /// the unified Timeline's iPhone Preview sibling list interleaves
    /// PhotoKit-local cells with cloud cells from several servers, so there
    /// is no single ambient `ImageSource` that's correct for every asset in
    /// it (passing one `PhotoKitSource` as `source` would misroute the cloud
    /// cells). The `source is PhotoKitSource` check is kept as a fallback for
    /// refs that predate provenance tagging or come from a genuinely
    /// single-source list (the normal PhotoKit-filter browse, where `source`
    /// really is the one true backend for every asset) — never the ONLY
    /// signal.
    static func thumbnailSource(
        for asset: AssetRef,
        source: (any ImageSource)?
    ) -> ThumbnailSource {
        let isPhotoKitBacked: Bool = {
            // Provenance, when present, is authoritative in BOTH directions.
            // Falling through to the ambient-source check for a `.cloud` ref
            // would reintroduce exactly the misroute this tag exists to stop:
            // in a mixed sibling list the ambient `source` may well be the
            // one `PhotoKitSource`, and a cloud ref with no `primaryURL`
            // would then resolve to `.photoKit(localID:)` and fail to paint.
            if let provenance = asset.thumbnailProvenance {
                return provenance == .photoKit
            }
            return asset.primaryURL == nil && source is PhotoKitSource
        }()
        if isPhotoKitBacked, let localID = asset.stableID {
            return .photoKit(localID: localID)
        }
        return .local(asset, source: source.map(ImageSourceBox.init))
    }

    // MARK: - Info pane presentation (#2405)

    /// Whether the Info pane should be presented open, given the current
    /// size class and the persisted `cm.preview.infoOpen` preference.
    ///
    /// Compact NEVER reads the stored preference — the iPhone bottom sheet
    /// always starts closed, because a sheet covering the photo on every
    /// Preview open is the wrong default for the surface whose whole
    /// purpose is showing the photo. Only the regular (tablet+) inspector
    /// column persists across opens.
    static func infoPaneShouldOpen(isRegular: Bool, storedPreference: Bool) -> Bool {
        isRegular ? storedPreference : false
    }

    /// Whether the Flag/Info `EditSession` needs priming right now. A closed
    /// pane primes nothing — Preview's whole point is that merely looking at
    /// a photo costs zero session/pipeline work. An open pane with no
    /// session yet needs one primed so it doesn't render empty.
    static func needsSessionPriming(isPaneOpen: Bool, hasSession: Bool) -> Bool {
        isPaneOpen && !hasSession
    }

    // MARK: - Zoom transition progress (iPhone push)

    /// Where the system zoom transition is between the grid tile (0) and the
    /// fullscreen Preview (1), derived from the destination's live frame.
    /// UIKit lays the destination out at every intermediate size, and it
    /// interpolates that frame linearly from the (square) tile rect to the
    /// full rect, so `width - height` grows linearly from 0 to
    /// `fullWidth - fullHeight`. That ratio is the progress, and it needs no
    /// knowledge of the tile's size or position. `nil` (no layout yet) reads
    /// as 0 so the first frames of a push never flash the fullscreen chrome.
    /// A near-square container (no usable difference) falls back to the
    /// width ratio.
    static func zoomTransitionProgress(size: CGSize?, fullSize: CGSize) -> CGFloat {
        guard let size, fullSize.width > 0, fullSize.height > 0 else { return 0 }
        // The two frames are measured by different views; a point of
        // disagreement at rest must still read as "settled", or the chrome
        // would sit at 96% and the display tier would never be requested.
        if abs(size.width - fullSize.width) <= zoomSettledTolerance,
           abs(size.height - fullSize.height) <= zoomSettledTolerance {
            return 1
        }
        let fullDelta = fullSize.width - fullSize.height
        let raw = abs(fullDelta) >= zoomNearSquareDelta
            ? (size.width - size.height) / fullDelta
            : size.width / fullSize.width
        return raw >= zoomSettledProgress ? 1 : min(1, max(0, raw))
    }

    /// Frames this close to the full size are the settled full size.
    static let zoomSettledTolerance: CGFloat = 1
    /// Progress this close to the end is the end (rounding in the frame
    /// interpolation can leave it a hair short).
    static let zoomSettledProgress: CGFloat = 0.98
    /// Below this width–height difference the container is too square for
    /// the difference to carry the signal; the width ratio stands in.
    static let zoomNearSquareDelta: CGFloat = 40

    /// Header / filmstrip / action-bar opacity during the zoom: hidden while
    /// the still is tile-sized, fading in over the last part of the open
    /// (and out over the first part of the close) so the chrome never
    /// shrinks into the tile with the photo.
    static func zoomTransitionChromeOpacity(progress: CGFloat) -> Double {
        Double(min(1, max(0, (progress - zoomChromeFadeStart) / (1 - zoomChromeFadeStart))))
    }

    /// The chrome fades in over the last quarter of the open.
    static let zoomChromeFadeStart: CGFloat = 0.75

    // MARK: - Pull-down dismissal (iPhone)

    /// Travel before a touch is classified as a pull or a page swipe. Long
    /// enough to read a direction from a real finger (whose first points
    /// wobble sideways), short enough that paging never feels delayed.
    static let pullDecisionDistance: CGFloat = 14
    /// A pull only has to be at least as vertical as it is horizontal —
    /// Photos' rule; anything stricter drops real pulls.
    static let pullVerticalDominance: CGFloat = 1

    /// Whether a pan that has just been recognised is a pull-down rather
    /// than a page swipe or an upward flick (let the pager have it). Decided
    /// once, after `pullDecisionDistance` of travel, and locked for the rest
    /// of the touch — a vertical pull never becomes a page turn halfway
    /// through.
    static func shouldBeginDismissDrag(translation: CGSize) -> Bool {
        translation.height > 0 && translation.height >= abs(translation.width) * pullVerticalDominance
    }

    // MARK: - Hero (iPhone open / close between the tile and fullscreen)

    /// Where the still is drawn at a point of the hero: a straight blend
    /// from the tile's frame (0) to the fit rect (1). Both are in the same
    /// coordinate space — the hero overlay's.
    static func heroRect(from tile: CGRect, to fit: CGRect, progress: CGFloat) -> CGRect {
        let t = min(1, max(0, progress))
        return CGRect(
            x: tile.minX + (fit.minX - tile.minX) * t,
            y: tile.minY + (fit.minY - tile.minY) * t,
            width: tile.width + (fit.width - tile.width) * t,
            height: tile.height + (fit.height - tile.height) * t
        )
    }

    /// The aspect-fit rect of a photo inside `bounds`.
    static func fitRect(imageSize: CGSize, in bounds: CGRect) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        let scale = min(bounds.width / imageSize.width, bounds.height / imageSize.height)
        let size = CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
        return CGRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
    }

    /// Tile corner radius fading to square as the hero opens.
    static func heroCornerRadius(progress: CGFloat, tileRadius: CGFloat) -> CGFloat {
        tileRadius * (1 - min(1, max(0, progress)))
    }

    // MARK: - Pull-down without a zoom (plain pushes)

    // A Preview pushed with no zoom source (the Search tab, a deep link)
    // has no system dismissal to hand a pull to, so it dismisses itself:
    // the still follows the finger and shrinks, and release past the
    // threshold pops the stack.

    /// Travel over which the still reaches `plainPullMinScale`.
    static let plainPullDistance: CGFloat = 320
    /// Smallest the still gets while pulled.
    static let plainPullMinScale: CGFloat = 0.6
    /// Travel over which the header / strips / bar fade away — quick, so
    /// the photo is alone on the backdrop well before a commit.
    static let plainPullChromeFadeDistance: CGFloat = 80

    /// 0…1 travel of the pull.
    static func plainPullProgress(translationY: CGFloat) -> CGFloat {
        min(1, max(0, translationY / plainPullDistance))
    }

    /// The still's scale for a given downward travel.
    static func plainPullScale(translationY: CGFloat) -> CGFloat {
        1 - plainPullProgress(translationY: translationY) * (1 - plainPullMinScale)
    }

    /// The dark backdrop thins out as the pull travels so what is beneath
    /// (the grid) shows through by the time the pull could commit.
    static func plainPullBackdropOpacity(translationY: CGFloat) -> Double {
        Double(1 - plainPullProgress(translationY: translationY))
    }

    /// Chrome opacity for a given downward travel.
    static func plainPullChromeOpacity(translationY: CGFloat) -> Double {
        Double(1 - min(1, max(0, translationY / plainPullChromeFadeDistance)))
    }

    /// A rect scaled about its own centre (the pull's `scaleEffect` anchor)
    /// and then offset — the same transform the pull applies to the still.
    static func pulledRect(_ rest: CGRect, scale: CGFloat, offset: CGSize) -> CGRect {
        let size = CGSize(width: rest.width * scale, height: rest.height * scale)
        return CGRect(
            x: rest.midX - size.width / 2 + offset.width,
            y: rest.midY - size.height / 2 + offset.height,
            width: size.width, height: size.height)
    }

    /// Commit the dismiss on release: enough travel, or a downward flick.
    static func shouldCommitPlainPull(translationY: CGFloat, velocityY: CGFloat) -> Bool {
        translationY > 120 || (translationY > 0 && velocityY > 700)
    }
}
