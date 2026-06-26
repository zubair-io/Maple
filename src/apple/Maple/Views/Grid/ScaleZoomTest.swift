// ScaleZoomTest.swift — THROWAWAY prototype (#1550).
//
// Validates the "fixed-N grid + single scaleEffect, overflow clipped" zoom:
// the grid is ALWAYS `baseColumns` (9) wide; "zooming" scales it so T visible
// columns fill the screen, clipping the rest. No LazyVGrid reflow → the zoom is
// one GPU transform, so it's smooth.
//
// Unified transform model (no ScrollView; mirrors the editor's CanvasZoomHost):
//   screen = contentBase * scale + offset,  anchor = .topLeading (always).
//   - ZOOM about the pinch focal = keep the content point under the finger fixed
//     (anchoredPan): offset = focalScreen - focalContent * scale.
//   - VERTICAL SCROLL = a clamped offset.height driven by a DragGesture.
//   - On release: snap T∈{9,5,3,1}; gap-aware scale s(T) makes T columns fill the
//     width exactly; horizontal offset snaps a whole column to x=0 (edge-aligned,
//     focal kept on its side); vertical offset preserves the focal row.
//
// Reachable via the temporary 🧪 button in LibraryGrid. DELETE this file + that
// button once the approach is decided.

#if os(iOS)

import SwiftUI

struct ScaleZoomTest: View {
    let onClose: () -> Void

    private let baseColumns = 9
    private let levels = [9, 5, 3, 1]   // visible-column targets (zoomed out → in)
    private let gap: CGFloat = 2

    // Committed transform (continuously updated during gestures).
    @State private var scale: CGFloat = 1          // = s(T); 1 at the 9-wide base
    @State private var offset: CGSize = .zero       // screen points, top-leading
    @State private var levelIndex = 0

    // Live-gesture scratch.
    @State private var pinching = false
    @State private var gestureStartScale: CGFloat = 1
    @State private var focalScreen: CGPoint = .zero  // finger point in viewport pts
    @State private var focalContent: CGPoint = .zero // content point under the finger
    @State private var dragging = false
    @State private var dragBaseY: CGFloat = 0
    @State private var dragSuppressed = false        // pinch owns the gesture briefly

    private var targetColumns: Int { levels[levelIndex] }

    var body: some View {
        GeometryReader { geo in
            let W = geo.size.width
            let H = geo.size.height
            let cell = (W - gap * CGFloat(baseColumns - 1)) / CGFloat(baseColumns)
            let pitch = cell + gap
            let count = baseColumns * 26
            let rows = Int(ceil(Double(count) / Double(baseColumns)))
            let baseContentH = CGFloat(rows) * cell + CGFloat(max(rows - 1, 0)) * gap

            grid(cell: cell, count: count)
                .frame(width: W, alignment: .topLeading)
                .scaleEffect(scale, anchor: .topLeading)
                .offset(offset)
                .frame(width: W, height: H, alignment: .topLeading)
                .clipped()
                .contentShape(Rectangle())
                .gesture(magnify(W: W, H: H, pitch: pitch, cell: cell, baseContentH: baseContentH))
                .simultaneousGesture(verticalDrag(H: H, baseContentH: baseContentH))
        }
        .ignoresSafeArea()
        .background(Color.black)
        .overlay(alignment: .top) { hud }
    }

    // MARK: - Grid leaf
    @ViewBuilder
    private func grid(cell: CGFloat, count: Int) -> some View {
        let cols = Array(repeating: GridItem(.fixed(cell), spacing: gap), count: baseColumns)
        LazyVGrid(columns: cols, spacing: gap) {
            ForEach(0..<count, id: \.self) { i in
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(hue: Double(i % 18) / 18.0, saturation: 0.55, brightness: 0.92))
                    .frame(height: cell)
                    .overlay(
                        Text("\(i)")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.9))
                    )
            }
        }
    }

    // MARK: - Math helpers

    /// Gap-aware scale so T columns (with gaps) fill W exactly. NOT B/T.
    private func levelScale(_ T: Int, cell: CGFloat, W: CGFloat) -> CGFloat {
        W / (CGFloat(T) * cell + CGFloat(T - 1) * gap)
    }

    /// Clamp the vertical offset to the scroll range (top-anchored: [-maxDown, 0]).
    private func clampY(_ y: CGFloat, scale s: CGFloat, H: CGFloat, baseContentH: CGFloat) -> CGFloat {
        let maxDown = max(0, baseContentH * s - H)
        return min(0, max(-maxDown, y))
    }

    // MARK: - Pinch (zoom about focal; snap + edge-align on release)
    private func magnify(W: CGFloat, H: CGFloat, pitch: CGFloat, cell: CGFloat, baseContentH: CGFloat) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                if !pinching {
                    pinching = true
                    dragSuppressed = true
                    gestureStartScale = scale
                    focalScreen = CGPoint(x: value.startAnchor.x * W, y: value.startAnchor.y * H)
                    // Content point currently under the finger.
                    focalContent = CGPoint(
                        x: (focalScreen.x - offset.width) / scale,
                        y: (focalScreen.y - offset.height) / scale
                    )
                }
                let mag = min(max(value.magnification, 0.4), 2.5)
                let newScale = gestureStartScale * mag
                // Keep the focal content point pinned under the finger (zoom-under-finger).
                scale = newScale
                offset = CGSize(
                    width: focalScreen.x - focalContent.x * newScale,
                    height: clampY(focalScreen.y - focalContent.y * newScale,
                                   scale: newScale, H: H, baseContentH: baseContentH)
                )
            }
            .onEnded { value in
                let zoomIn = value.magnification > 1.15
                let zoomOut = value.magnification < 0.87
                let newIndex = zoomIn ? min(levelIndex + 1, levels.count - 1)
                             : zoomOut ? max(levelIndex - 1, 0)
                             : levelIndex
                let T = levels[newIndex]
                let newScale = levelScale(T, cell: cell, W: W)

                // Focal base-column (content coords are zoom-independent).
                let f = min(max(Int(focalContent.x / pitch), 0), baseColumns - 1)
                // Side intent: keep on its side on zoom-in; center on zoom-out.
                let sidePos: Int = zoomOut ? (T - 1) / 2
                    : focalScreen.x / W < 1.0 / 3 ? 0
                    : focalScreen.x / W > 2.0 / 3 ? (T - 1)
                    : (T - 1) / 2
                let cLeft = min(max(f - sidePos, 0), baseColumns - T)
                let newTX = -newScale * CGFloat(cLeft) * pitch
                // Preserve the focal row: keep the focal content-y under the focal screen-y.
                let newOY = clampY(focalScreen.y - focalContent.y * newScale,
                                   scale: newScale, H: H, baseContentH: baseContentH)

                withAnimation(.smooth(duration: 0.38)) {
                    levelIndex = newIndex
                    scale = newScale
                    offset = CGSize(width: newTX, height: newOY)
                }
                pinching = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    dragSuppressed = false
                }
            }
    }

    // MARK: - Vertical drag (scroll), coexisting with pinch
    private func verticalDrag(H: CGFloat, baseContentH: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                guard !pinching, !dragSuppressed else { return }
                if !dragging { dragging = true; dragBaseY = offset.height }
                offset.height = clampY(dragBaseY + value.translation.height,
                                       scale: scale, H: H, baseContentH: baseContentH)
            }
            .onEnded { _ in dragging = false }
    }

    private var hud: some View {
        HStack {
            Text("\(targetColumns)-wide  scale \(String(format: "%.2f", scale))  y \(Int(offset.height))")
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

#endif
