// PreviewDestination.swift — iPhone push wrapper for the fast Preview surface
// (Fast Preview epic §1/§4).
//
// Sibling of `EditorDestination`. The Library tab's
// `.navigationDestination(for: LibraryDestination.self)` resolves a
// `.preview(asset)` push to this view; it hands the current-folder asset list,
// the browse source, and the session cache to `PreviewView` and wires:
//   • back        → `dismiss()` (pops Preview off the stack, back to the grid)
//   • Edit        → push `.edit(asset)` onto the same stack (→ EditorDestination)
//   • prev/next   → swap the shown asset in place (no push) and keep the browse
//                   VM's `selectedID` in sync so a later Edit / return-to-grid
//                   lands on the right asset.
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

    /// Push the editor for `asset` onto the same NavigationStack. Wired by
    /// `PhoneLibraryView` to append `.edit(asset)` to `libraryPath`.
    let onEdit: (AssetRef) -> Void
    /// Keep the browse VM's selection in sync as Preview navigates siblings, so
    /// the grid + a subsequent editor open track the visible asset.
    let onSelectionChanged: (AssetRef) -> Void

    @Environment(\.dismiss) private var dismiss

    /// The id currently shown — starts at the pushed `asset`, moves on
    /// swipe / arrow / filmstrip. Kept local so prev/next never pushes a new
    /// stack entry (spec §4: navigation swaps the preview in place).
    @State private var shownID: AssetRef.ID?

    private var shownAsset: AssetRef {
        assets.first { $0.id == shownID } ?? asset
    }

    var body: some View {
        PreviewView(
            asset: shownAsset,
            assets: assets,
            source: source,
            sessions: $sessions,
            onDismiss: { dismiss() },
            onEdit: onEdit,
            onSelectAsset: { next in
                shownID = next.id
                onSelectionChanged(next)
            }
        )
        .task(id: asset.id) {
            // Land on the pushed asset. `.task(id:)` only fires on an actual
            // `asset.id` change (or initial appearance), so this is safe to run
            // unconditionally — a guard would leave `shownID` stale if the
            // parent re-pushed a different asset while this view was still on
            // screen (jules review).
            shownID = asset.id
        }
    }
}

#endif
