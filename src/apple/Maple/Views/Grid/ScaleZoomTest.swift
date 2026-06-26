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
            let count = baseColumns * 80   // plenty of rows to test scrolling
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

    /// The level whose gap-aware scale is nearest (in log space, since zoom is
    /// multiplicative) to `s`. Lets a big pinch jump several levels (9→3, 5→1)
    /// instead of always stepping ±1.
    private func nearestLevelIndex(toScale s: CGFloat, cell: CGFloat, W: CGFloat) -> Int {
        var best = 0
        var bestDist = CGFloat.greatestFiniteMagnitude
        for (i, T) in levels.enumerated() {
            let d = abs(log(levelScale(T, cell: cell, W: W)) - log(s))
            if d < bestDist { bestDist = d; best = i }
        }
        return best
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
                // Wide clamp (just a runaway guard) so a hard pinch can traverse
                // multiple levels in one gesture instead of hitting an artificial cap.
                let mag = min(max(value.magnification, 0.08), 12)
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
                // Snap to the level nearest where the pinch actually landed, so a
                // big pinch jumps multiple levels (9→3, 5→1), a small one steps once.
                let newIndex = nearestLevelIndex(toScale: scale, cell: cell, W: W)
                let zoomOut = newIndex < levelIndex
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
            .onEnded { value in
                guard !pinching, !dragSuppressed else { dragging = false; return }
                dragging = false
                // Momentum: project a fling endpoint from the release velocity and
                // ease to it, so a flick coasts instead of stopping at the finger.
                let v = value.velocity.height            // pts/sec (iOS 17+)
                // Stronger momentum: project further and decelerate over longer.
                let projected = offset.height + v * 0.42
                let target = clampY(projected, scale: scale, H: H, baseContentH: baseContentH)
                withAnimation(.easeOut(duration: min(max(abs(v) / 1500, 0.3), 1.6))) {
                    offset.height = target
                }
            }
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
