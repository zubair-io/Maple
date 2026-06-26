// ScaleZoomTest.swift — THROWAWAY prototype (#1550).
//
// Tests the "fixed-N grid + scaleEffect, overflow clipped" zoom hypothesis:
// the grid is ALWAYS `baseColumns` (9) wide; "zooming" scales it so a subset of
// columns fills the viewport, clipping the rest off the sides. Because it's a
// single GPU transform (no LazyVGrid reflow), the animation should be perfectly
// smooth — that's what we're validating here, in isolation from scrolling.
//
// Not wired into the real grid. Reachable via a temporary "🧪" button in
// LibraryGrid. DELETE this file + that button once the approach is decided.

#if os(iOS)

import SwiftUI

struct ScaleZoomTest: View {
    let onClose: () -> Void

    /// The grid is always laid out this many columns wide.
    private let baseColumns = 9
    /// Visible-column targets per level (left→right = zoomed out→in).
    private let levels = [9, 5, 3, 1]
    private let gap: CGFloat = 2

    /// Index into `levels`. Starts at 9-wide (most columns, smallest cells).
    @State private var levelIndex = 0
    /// Live pinch multiplier on top of the level's scale (1 between gestures).
    @State private var liveScale: CGFloat = 1
    /// Scale anchor = the pinch focal point, so it zooms under the fingers.
    @State private var anchor: UnitPoint = .topLeading
    @State private var pinching = false

    private var targetColumns: Int { levels[levelIndex] }
    /// Scale that makes `targetColumns` of the `baseColumns` fill the width.
    private var levelScale: CGFloat { CGFloat(baseColumns) / CGFloat(targetColumns) }

    var body: some View {
        GeometryReader { geo in
            let baseCell = (geo.size.width - gap * CGFloat(baseColumns - 1)) / CGFloat(baseColumns)
            let cols = Array(repeating: GridItem(.fixed(baseCell), spacing: gap), count: baseColumns)
            // Enough boxes to more than fill the screen at 9-wide.
            let count = baseColumns * 26

            LazyVGrid(columns: cols, spacing: gap) {
                ForEach(0..<count, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color(hue: Double(i % 18) / 18.0, saturation: 0.55, brightness: 0.92))
                        .frame(height: baseCell)
                        .overlay(
                            Text("\(i)")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.9))
                        )
                }
            }
            .frame(width: geo.size.width, alignment: .topLeading)
            // The whole transform: level scale * live pinch, about the focal point.
            .scaleEffect(levelScale * liveScale, anchor: anchor)
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            .clipped()
            .contentShape(Rectangle())
            .gesture(
                MagnifyGesture()
                    .onChanged { value in
                        if !pinching { anchor = value.startAnchor; pinching = true }
                        liveScale = min(max(value.magnification, 0.4), 2.5)
                    }
                    .onEnded { value in
                        let zoomIn = value.magnification > 1.15   // spread → fewer cols
                        let zoomOut = value.magnification < 0.87  // pinch → more cols
                        withAnimation(.smooth(duration: 0.38)) {
                            if zoomIn { levelIndex = min(levelIndex + 1, levels.count - 1) }
                            else if zoomOut { levelIndex = max(levelIndex - 1, 0) }
                            liveScale = 1
                        }
                        pinching = false
                    }
            )
        }
        .ignoresSafeArea()
        .background(Color.black)
        .overlay(alignment: .top) {
            HStack {
                Text("\(targetColumns)-wide  (scale \(String(format: "%.2f", levelScale)))")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white)
                Spacer()
                Button("Close", action: onClose)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .background(.black.opacity(0.4))
        }
    }
}

#endif
