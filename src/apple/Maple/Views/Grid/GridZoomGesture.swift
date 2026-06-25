// GridZoomGesture.swift — pinch-to-zoom modifier for photo grids (#1550).
//
// Encapsulates the `MagnifyGesture` so all three grid surfaces
// (LibraryGrid, BrowseGrid, CloudTimelineView) get identical behaviour.
//
// The grid scales live under the fingers during the pinch (visual feedback),
// then snaps to a discrete level on release:
//   onChanged → apply the magnification as a clamped `scaleEffect`. The column
//               count is NOT changed mid-gesture — reflowing the LazyVGrid every
//               frame would thrash a large thumbnail grid. The user still sees
//               the images grow/shrink because the whole viewport scales.
//   onEnded   → magnification > 1.25 steps to bigger cells (zoomedIn), < 0.80 to
//               smaller (zoomedOut); the real column count changes here and the
//               live scale animates back to 1, so the new layout settles smoothly.
//               At the clamped level ends the scale simply rubber-bands back.
//
// `.simultaneousGesture` lets the pinch coexist with the scroll view's pan.

import SwiftUI
import MapleCore

private struct GridZoomPinch: ViewModifier {
    @Binding var level: GridZoomLevel
    @State private var liveScale: CGFloat = 1

    func body(content: Content) -> some View {
        content
            .scaleEffect(liveScale, anchor: .center)
            .simultaneousGesture(
                MagnifyGesture()
                    .onChanged { value in
                        // Live feedback only — clamp so the grid can't run away,
                        // and so pinching past a clamped end rubber-bands back.
                        liveScale = min(max(value.magnification, 0.55), 1.8)
                    }
                    .onEnded { value in
                        let snapped = value.magnification > 1.25 ? level.zoomedIn()
                                    : value.magnification < 0.8  ? level.zoomedOut()
                                    : level
                        withAnimation(.smooth) {
                            level = snapped
                            liveScale = 1
                        }
                    }
            )
    }
}

extension View {
    /// Pinch-to-zoom the photo grid: scales live under the fingers, then snaps to
    /// a discrete `GridZoomLevel` on release. Apply to the scroll container.
    func gridZoomPinch(level: Binding<GridZoomLevel>) -> some View {
        modifier(GridZoomPinch(level: level))
    }
}
