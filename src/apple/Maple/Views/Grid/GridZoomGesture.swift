// GridZoomGesture.swift — pinch-to-step zoom modifier for photo grids (#1550).
//
// Encapsulates the `MagnifyGesture` so all three grid surfaces
// (LibraryGrid, BrowseGrid, CloudTimelineView) get identical behaviour.
//
// Design: the gesture is discrete — the live magnification value is NOT
// applied during the gesture. Only the final magnitude is checked:
//   > 1.25  → one step toward bigger cells (zoomedIn)
//   < 0.80  → one step toward smaller cells (zoomedOut)
// This matches the spec's "one step per gesture" requirement and avoids
// the complexity of a continuous zoom layout.
//
// `.simultaneousGesture` lets the gesture coexist with the scroll view's
// pan gesture without swallowing scrolls.

import SwiftUI
import MapleCore

private struct GridZoomPinch: ViewModifier {
    @Binding var level: GridZoomLevel

    func body(content: Content) -> some View {
        content.simultaneousGesture(
            MagnifyGesture().onEnded { value in
                if value.magnification > 1.25 {
                    withAnimation(.smooth) { level = level.zoomedIn() }
                } else if value.magnification < 0.8 {
                    withAnimation(.smooth) { level = level.zoomedOut() }
                }
            }
        )
    }
}

extension View {
    /// Pinch-to-step the photo-grid zoom level. Apply to the scrollable grid
    /// container. One step per gesture; does not apply continuous scale.
    func gridZoomPinch(level: Binding<GridZoomLevel>) -> some View {
        modifier(GridZoomPinch(level: level))
    }
}
