// PreviewDestination.swift — iPhone push wrapper for the fast Preview surface
// (Fast Preview epic §1/§4).
//
// Sibling of `EditorDestination`. The Library tab's
// `.navigationDestination(for: LibraryDestination.self)` resolves a
// `.preview(asset)` push to this view; it hands the current-folder asset list,
// the browse source, and the session cache to `PreviewView` and wires:
//   • back        → pop Preview off the stack, back to the grid
//   • Edit        → push `.edit(asset)` onto the same stack (→ EditorDestination)
//   • prev/next   → swap the shown asset in place (no push) and keep the browse
//                   VM's `selectedID` in sync so a later Edit / return-to-grid
//                   lands on the right asset.
//
// Zoom transition: when the pushing surface hands over its `@Namespace`
// (the Library grid tags every cell with `matchedTransitionSource`, keyed by
// `PhotoGridItem.id` — `stableID ?? id.uuidString` for a local asset), the
// push and pop run the system zoom transition: the tile grows into the
// fullscreen still, and the pop (back button, edge swipe, or the built-in
// drag / pinch-to-dismiss) shrinks it back into the tile. The `sourceID`
// tracks the asset CURRENTLY shown, not the one first pushed, so after
// paging the dismiss lands on the right tile. `LibraryGrid` scrolls that
// tile into view as the selection moves (it is covered by Preview at the
// time), so the system always finds a live source frame.
//
// Preview deliberately does NOT create a render session. It reuses whatever
// `EditSession` the grid already primed (via `ensureSession`) for Flag/Info;
// `PreviewView` primes a pipeline-free one on demand if none exists. The heavy
// editor session is built by `EditorDestination` only once Edit is tapped.

#if os(iOS)

import SwiftUI
import MapleCore

struct PreviewDestination: View {
    /// The asset first pushed. Local navigation (swipe / arrow / filmstrip)
    /// updates `shownID`; the displayed asset is resolved from `assets`.
    let asset: AssetRef
    /// Ordered assets in the current folder — filmstrip contents + prev/next
    /// domain. Sourced from `BrowseViewModel.assets` at push time.
    let assets: [AssetRef]
    /// Browse source for sourceless thumbnail resolution (cloud / PhotoKit).
    let source: (any ImageSource)?
    @Binding var sessions: [AssetRef.ID: EditSession]
    let onClose: () -> Void

    /// Push the editor for `asset` onto the same NavigationStack. Wired by
    /// `PhoneLibraryView` to append `.edit(asset)` to `libraryPath`.
    let onEdit: (AssetRef) -> Void
    /// Keep the browse VM's selection in sync as Preview navigates siblings, so
    /// the grid + a subsequent editor open track the visible asset.
    let onSelectionChanged: (AssetRef) -> Void
    /// The pushing grid's zoom-transition namespace. `nil` (Search tab, deep
    /// links with no grid on screen) keeps the standard push.
    var transitionNamespace: Namespace.ID? = nil
    /// The size this destination has once fully pushed (the Library tab's
    /// full frame, safe areas included — `PhoneLibraryView` measures it).
    /// Together with this view's live frame it yields the zoom's progress.
    var fullSize: CGSize = .zero

    /// The id currently shown — starts at the pushed `asset`, moves on
    /// swipe / arrow / filmstrip. Kept local so prev/next never pushes a new
    /// stack entry (spec §4: navigation swaps the preview in place).
    @State private var shownID: AssetRef.ID?
    @State private var isClosing = false
    /// This view's live frame. UIKit resizes the pushed destination through
    /// every intermediate size of the zoom, so this walks from the tile's
    /// rect up to `fullSize` on push and back down on pop.
    @State private var liveSize: CGSize?

    private var shownAsset: AssetRef {
        assets.first { $0.id == shownID } ?? asset
    }

    /// Must equal the tag `PhotoGridItem(local:)` gives the matching cell.
    private var transitionSourceID: String {
        shownAsset.stableID ?? shownAsset.id.uuidString
    }

    private var transitionProgress: CGFloat {
        transitionNamespace == nil
            ? 1
            : PreviewViewVM.zoomTransitionProgress(size: liveSize, fullSize: fullSize)
    }

    var body: some View {
        PreviewView(
            asset: shownAsset,
            assets: assets,
            source: source,
            sessions: $sessions,
            onDismiss: close,
            onEdit: onEdit,
            onSelectAsset: { next in
                shownID = next.id
                onSelectionChanged(next)
            },
            transitionProgress: transitionProgress
        )
        .background {
            // Measured with the safe areas ignored so it matches `fullSize`
            // once the push has settled.
            Color.clear
                .ignoresSafeArea()
                .onGeometryChange(for: CGSize.self, of: { $0.size }) { liveSize = $0 }
        }
        .modifier(ZoomNavigationTransition(sourceID: transitionSourceID, namespace: transitionNamespace))
        .task(id: asset.id) {
            // Land on the pushed asset. `.task(id:)` only fires on an actual
            // `asset.id` change (or initial appearance), so this is safe to run
            // unconditionally — a guard would leave `shownID` stale if the
            // parent re-pushed a different asset while this view was still on
            // screen (jules review).
            shownID = asset.id
        }
    }

    private func close() {
        guard !isClosing else { return }
        isClosing = true
        onClose()
    }
}

/// `.navigationTransition(.zoom)` only when the pusher supplied a namespace.
private struct ZoomNavigationTransition: ViewModifier {
    let sourceID: String
    let namespace: Namespace.ID?

    func body(content: Content) -> some View {
        if let namespace {
            content.navigationTransition(.zoom(sourceID: sourceID, in: namespace))
        } else {
            content
        }
    }
}

#endif
