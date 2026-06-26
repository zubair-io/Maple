// ScaleZoomTest.swift — THROWAWAY prototype (#1550).
//
// Scale-based grid zoom with content repacking + a crossfade settle:
//   - Each level T renders a T-column grid of ALL images, scaled (single GPU
//     transform) so the zoom is smooth; vertical scroll is a clamped offset.
//   - The pinched image is tracked and kept under the finger (focal-anchored,
//     both axes) through the zoom AND the settle.
//   - On settle the level changes by repacking into T columns. To avoid the
//     content "blink", the outgoing packing CROSSFADES into the incoming one
//     over the held focal — two layers, both focal-anchored, opacity dissolve.
//
// Reachable via the temporary 🧪 button in LibraryGrid. DELETE once decided.

#if os(iOS)

import SwiftUI

struct ScaleZoomTest: View {
    let onClose: () -> Void

    private let levels = [9, 5, 3, 1]   // visible-column targets (out → in)
    private let baseColumns = 9         // cell SIZE basis (cell = width / 9)
    private let gap: CGFloat = 2
    private let total = 200             // number of "photos" to browse

    // Resting transform.
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var levelIndex = 0
    @State private var focalImage: Int? = nil

    // Gesture scratch.
    @State private var pinching = false
    @State private var gestureStartScale: CGFloat = 1
    @State private var focalScreen: CGPoint = .zero
    @State private var focalFallback: CGPoint = .zero
    @State private var dragging = false
    @State private var dragBaseY: CGFloat = 0
    @State private var dragSuppressed = false

    // Crossfade transition.
    @State private var transitioning = false
    @State private var fade: Double = 0        // 0 = outgoing, 1 = incoming (opacity dissolve)
    @State private var outLevelIndex = 0
    @State private var tScale: CGFloat = 1      // outgoing scale settle during the transition

    private var targetColumns: Int { levels[levelIndex] }

    var body: some View {
        GeometryReader { geo in
            let W = geo.size.width
            let H = geo.size.height
            let cell = (W - gap * CGFloat(baseColumns - 1)) / CGFloat(baseColumns)
            let pitch = cell + gap

            ZStack(alignment: .topLeading) {
                if transitioning {
                    let nScale = levelScale(levels[levelIndex], cell: cell, W: W)
                    // Outgoing: old packing, scale settling, focal under the finger — fades out.
                    gridLayer(level: outLevelIndex, layerScale: tScale,
                              layerOffset: layerOffset(level: outLevelIndex, s: tScale, align: 0, cell: cell, pitch: pitch, H: H),
                              cell: cell)
                        .opacity(1 - fade)
                    // Incoming: new packing, already at its FINAL edge-aligned position
                    // (no horizontal motion) — just fades in.
                    gridLayer(level: levelIndex, layerScale: nScale,
                              layerOffset: layerOffset(level: levelIndex, s: nScale, align: 1, cell: cell, pitch: pitch, H: H),
                              cell: cell)
                        .opacity(fade)
                } else {
                    gridLayer(level: levelIndex, layerScale: scale, layerOffset: offset, cell: cell)
                }
            }
            .frame(width: W, height: H, alignment: .topLeading)
            .clipped()
            .contentShape(Rectangle())
            .gesture(magnify(W: W, H: H, pitch: pitch, cell: cell))
            .simultaneousGesture(verticalDrag(cell: cell, H: H))
        }
        .ignoresSafeArea()
        .background(Color.black)
        .overlay(alignment: .top) { hud }
    }

    // MARK: - Grid layer (T columns of ALL images, scaled)

    @ViewBuilder
    private func gridLayer(level: Int, layerScale: CGFloat, layerOffset: CGSize, cell: CGFloat) -> some View {
        let T = levels[level]
        let cols = Array(repeating: GridItem(.fixed(cell), spacing: gap), count: T)
        let contentW = CGFloat(T) * cell + CGFloat(T - 1) * gap
        LazyVGrid(columns: cols, spacing: gap) {
            ForEach(0..<total, id: \.self) { idx in
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(hue: Double(idx % 18) / 18.0, saturation: 0.55, brightness: 0.92))
                    .frame(height: cell)
                    .overlay(
                        Text("\(idx)")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.9))
                    )
            }
        }
        .frame(width: contentW, alignment: .topLeading)
        .scaleEffect(layerScale, anchor: .topLeading)
        .offset(layerOffset)
    }

    // MARK: - Math

    private func rowCount(forT T: Int) -> Int { Int(ceil(Double(total) / Double(T))) }

    private func baseContentHeight(forT T: Int, cell: CGFloat) -> CGFloat {
        let rows = rowCount(forT: T)
        return CGFloat(rows) * cell + CGFloat(max(rows - 1, 0)) * gap
    }

    /// Scale so a T-column grid (base cell size) fills the width.
    private func levelScale(_ T: Int, cell: CGFloat, W: CGFloat) -> CGFloat {
        W / (CGFloat(T) * cell + CGFloat(T - 1) * gap)
    }

    private func clampY(_ y: CGFloat, scale s: CGFloat, H: CGFloat, baseContentH: CGFloat) -> CGFloat {
        let maxDown = max(0, baseContentH * s - H)
        return min(0, max(-maxDown, y))
    }

    private func imageIndex(r: Int, c: Int, T: Int) -> Int? {
        guard c >= 0, c < T else { return nil }
        let idx = r * T + c
        return idx < total ? idx : nil
    }

    /// Layer offset. Vertical is always focal-anchored (the focal row stays under
    /// the finger). Horizontal lerps by `align`: 0 = focal under the finger,
    /// 1 = edge-aligned (column 0 at the left edge → columns snap to both edges).
    /// Live uses align 0 (under finger); rest/settle uses align 1 (edge-aligned).
    private func layerOffset(level: Int, s: CGFloat, align: Double, cell: CGFloat, pitch: CGFloat, H: CGFloat) -> CGSize {
        let T = levels[level]
        let bch = baseContentHeight(forT: T, cell: cell)
        let cx: CGFloat, cy: CGFloat
        if let img = focalImage {
            cx = CGFloat(img % T) * pitch + cell / 2
            cy = CGFloat(img / T) * (cell + gap) + cell / 2
        } else {
            cx = focalFallback.x
            cy = focalFallback.y
        }
        let w = (focalScreen.x - cx * s) * (1 - align)   // → 0 as align→1 (edge-aligned)
        return CGSize(width: w,
                      height: clampY(focalScreen.y - cy * s, scale: s, H: H, baseContentH: bch))
    }

    // MARK: - Pinch (zoom + crossfade settle)

    private func magnify(W: CGFloat, H: CGFloat, pitch: CGFloat, cell: CGFloat) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                if !pinching {
                    pinching = true
                    dragSuppressed = true
                    gestureStartScale = scale
                    focalScreen = CGPoint(x: value.startAnchor.x * W, y: value.startAnchor.y * H)
                    let cp = CGPoint(x: (focalScreen.x - offset.width) / scale,
                                     y: (focalScreen.y - offset.height) / scale)
                    focalFallback = cp
                    focalImage = imageIndex(r: Int(cp.y / (cell + gap)), c: Int(cp.x / pitch), T: targetColumns)
                }
                let mag = min(max(value.magnification, 0.08), 12)
                scale = gestureStartScale * mag
                offset = layerOffset(level: levelIndex, s: scale, align: 0, cell: cell, pitch: pitch, H: H)
            }
            .onEnded { value in
                let mag = value.magnification
                let liveScale = scale
                let newIndex: Int
                if mag > 1.05 {
                    var idx = levels.count - 1
                    for i in 0..<levels.count where levelScale(levels[i], cell: cell, W: W) >= liveScale { idx = i; break }
                    newIndex = idx
                } else if mag < 0.95 {
                    var idx = 0
                    for i in 0..<levels.count where levelScale(levels[i], cell: cell, W: W) <= liveScale { idx = i }
                    newIndex = idx
                } else {
                    newIndex = levelIndex
                }
                let newScale = levelScale(levels[newIndex], cell: cell, W: W)
                pinching = false

                if newIndex == levelIndex {
                    // No level change — settle scale back + edge-align.
                    withAnimation(.smooth(duration: 0.30)) {
                        scale = newScale
                        offset = layerOffset(level: levelIndex, s: newScale, align: 1, cell: cell, pitch: pitch, H: H)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { dragSuppressed = false }
                    return
                }

                // Dissolve the old packing into the new one. No horizontal motion:
                // the incoming layer is rendered at its final edge-aligned position
                // and only its opacity fades in. The outgoing settles its scale
                // (focal stays under the finger) and fades out.
                outLevelIndex = levelIndex
                levelIndex = newIndex
                tScale = liveScale
                fade = 0
                transitioning = true
                // Outgoing scale settle (focal-anchored, no slide).
                withAnimation(.smooth(duration: 0.46)) {
                    tScale = newScale
                }
                // Content dissolve: delayed start, then dissolve.
                withAnimation(.smooth(duration: 1.0).delay(0.2)) {
                    fade = 1
                } completion: {
                    scale = newScale
                    offset = layerOffset(level: newIndex, s: newScale, align: 1, cell: cell, pitch: pitch, H: H)
                    transitioning = false
                    fade = 0
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { dragSuppressed = false }
            }
    }

    // MARK: - Vertical drag (scroll) with momentum

    private func verticalDrag(cell: CGFloat, H: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                guard !pinching, !dragSuppressed, !transitioning else { return }
                if !dragging { dragging = true; dragBaseY = offset.height }
                let bch = baseContentHeight(forT: targetColumns, cell: cell)
                offset.height = clampY(dragBaseY + value.translation.height, scale: scale, H: H, baseContentH: bch)
            }
            .onEnded { value in
                guard !pinching, !dragSuppressed, !transitioning else { dragging = false; return }
                dragging = false
                let v = value.velocity.height
                let bch = baseContentHeight(forT: targetColumns, cell: cell)
                let target = clampY(offset.height + v * 0.42, scale: scale, H: H, baseContentH: bch)
                withAnimation(.easeOut(duration: min(max(abs(v) / 1500, 0.3), 1.6))) {
                    offset.height = target
                }
            }
    }

    private var hud: some View {
        HStack {
            Text("\(targetColumns)-wide  scale \(String(format: "%.2f", scale))  focal \(focalImage.map(String.init) ?? "-")")
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
