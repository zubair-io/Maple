// ScaleZoomTest.swift — THROWAWAY prototype (#1550).
//
// Fixed 9-column grid + single scaleEffect zoom (smooth, no reflow), custom
// transform vertical scroll. All the zoom/scale/scroll logic is unchanged; the
// ADDON here is content mapping: per level the visible T columns are packed with
// the full image sequence (`row*T + col-offset`, ceil(total/T) rows deep) and the
// off-screen columns render empty — so every image is browsable at every level,
// and zooming out visibly fills the side columns from the rows below. Order is
// not preserved across a level change (accepted).
//
// Reachable via the temporary 🧪 button in LibraryGrid. DELETE once decided.

#if os(iOS)

import SwiftUI

struct ScaleZoomTest: View {
    let onClose: () -> Void

    private let baseColumns = 9
    private let levels = [9, 5, 3, 1]   // visible-column targets (out → in)
    private let gap: CGFloat = 2
    private let total = 180             // number of "photos" to browse

    // Committed transform (updated live during gestures).
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var levelIndex = 0
    /// The image under the finger when a pinch begins — preserved across the
    /// level change so zooming into image N keeps showing image N.
    @State private var focalImage: Int? = nil

    // Live-gesture scratch.
    @State private var pinching = false
    @State private var gestureStartScale: CGFloat = 1
    @State private var focalScreen: CGPoint = .zero
    @State private var focalContent: CGPoint = .zero
    @State private var dragging = false
    @State private var dragBaseY: CGFloat = 0
    @State private var dragSuppressed = false

    private var targetColumns: Int { levels[levelIndex] }

    var body: some View {
        GeometryReader { geo in
            let W = geo.size.width
            let H = geo.size.height
            let cell = (W - gap * CGFloat(baseColumns - 1)) / CGFloat(baseColumns)
            let pitch = cell + gap
            let T = targetColumns
            let rows = rowCount(forT: T)
            let baseContentH = baseContentHeight(forT: T, cell: cell)

            grid(cell: cell, T: T, cLeft: 0, rows: rows)
                .frame(width: W, alignment: .topLeading)
                .scaleEffect(scale, anchor: .topLeading)
                .offset(offset)
                .frame(width: W, height: H, alignment: .topLeading)
                .clipped()
                .contentShape(Rectangle())
                .gesture(magnify(W: W, H: H, pitch: pitch, cell: cell))
                .simultaneousGesture(verticalDrag(H: H, baseContentH: baseContentH))
        }
        .ignoresSafeArea()
        .background(Color.black)
        .overlay(alignment: .top) { hud }
    }

    // MARK: - Grid (content-mapped)

    @ViewBuilder
    private func grid(cell: CGFloat, T: Int, cLeft: Int, rows: Int) -> some View {
        let cols = Array(repeating: GridItem(.fixed(cell), spacing: gap), count: baseColumns)
        LazyVGrid(columns: cols, spacing: gap) {
            ForEach(0..<(baseColumns * rows), id: \.self) { i in
                cellView(r: i / baseColumns, c: i % baseColumns, T: T, cLeft: cLeft, cell: cell)
            }
        }
    }

    /// The image index shown at physical cell (r, c) for the current packing, or
    /// nil if this cell is outside the visible columns / past the end.
    private func imageIndex(r: Int, c: Int, T: Int, cLeft: Int) -> Int? {
        guard c >= cLeft, c < cLeft + T else { return nil }
        let idx = r * T + (c - cLeft)
        return idx < total ? idx : nil
    }

    @ViewBuilder
    private func cellView(r: Int, c: Int, T: Int, cLeft: Int, cell: CGFloat) -> some View {
        if let idx = imageIndex(r: r, c: c, T: T, cLeft: cLeft) {
            RoundedRectangle(cornerRadius: 3)
                .fill(Color(hue: Double(idx % 18) / 18.0, saturation: 0.55, brightness: 0.92))
                .frame(height: cell)
                .overlay(
                    Text("\(idx)")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.9))
                )
        } else {
            Color.clear.frame(height: cell)   // empty side / tail cell
        }
    }

    // MARK: - Math helpers

    private func rowCount(forT T: Int) -> Int { Int(ceil(Double(total) / Double(T))) }

    private func baseContentHeight(forT T: Int, cell: CGFloat) -> CGFloat {
        let rows = rowCount(forT: T)
        return CGFloat(rows) * cell + CGFloat(max(rows - 1, 0)) * gap
    }

    /// Gap-aware scale so T columns fill W exactly.
    private func levelScale(_ T: Int, cell: CGFloat, W: CGFloat) -> CGFloat {
        W / (CGFloat(T) * cell + CGFloat(T - 1) * gap)
    }

    private func clampY(_ y: CGFloat, scale s: CGFloat, H: CGFloat, baseContentH: CGFloat) -> CGFloat {
        let maxDown = max(0, baseContentH * s - H)
        return min(0, max(-maxDown, y))
    }

    // MARK: - Pinch (zoom + settle; content remaps on level change)
    private func magnify(W: CGFloat, H: CGFloat, pitch: CGFloat, cell: CGFloat) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                if !pinching {
                    pinching = true
                    dragSuppressed = true
                    gestureStartScale = scale
                    focalScreen = CGPoint(x: value.startAnchor.x * W, y: value.startAnchor.y * H)
                    focalContent = CGPoint(
                        x: (focalScreen.x - offset.width) / scale,
                        y: (focalScreen.y - offset.height) / scale
                    )
                    // Which image is under the finger right now (old packing)?
                    let colFocal = Int(focalContent.x / pitch)
                    let rowFocal = Int(focalContent.y / (cell + gap))
                    focalImage = imageIndex(r: rowFocal, c: colFocal, T: targetColumns, cLeft: 0)
                }
                let mag = min(max(value.magnification, 0.08), 12)
                let newScale = gestureStartScale * mag
                let bch = baseContentHeight(forT: targetColumns, cell: cell)
                scale = newScale
                offset = CGSize(
                    width: focalScreen.x - focalContent.x * newScale,
                    height: clampY(focalScreen.y - focalContent.y * newScale,
                                   scale: newScale, H: H, baseContentH: bch)
                )
            }
            .onEnded { value in
                // Round toward the pinch direction (no opposite bounce; ≥1 level).
                let mag = value.magnification
                let liveScale = scale
                let newIndex: Int
                if mag > 1.05 {
                    var idx = levels.count - 1
                    for i in 0..<levels.count where levelScale(levels[i], cell: cell, W: W) >= liveScale {
                        idx = i; break
                    }
                    newIndex = idx
                } else if mag < 0.95 {
                    var idx = 0
                    for i in 0..<levels.count where levelScale(levels[i], cell: cell, W: W) <= liveScale {
                        idx = i
                    }
                    newIndex = idx
                } else {
                    newIndex = levelIndex
                }

                let T = levels[newIndex]
                let newScale = levelScale(T, cell: cell, W: W)
                let newBCH = baseContentHeight(forT: T, cell: cell)
                // Preserve the focal IMAGE: scroll its row in the NEW packing back
                // under the finger, so zooming into image N keeps N under your finger.
                let newOY: CGFloat
                if let img = focalImage {
                    let rowNew = img / T
                    newOY = clampY(focalScreen.y - CGFloat(rowNew) * (cell + gap) * newScale,
                                   scale: newScale, H: H, baseContentH: newBCH)
                } else {
                    newOY = clampY(focalScreen.y - focalContent.y * newScale,
                                   scale: newScale, H: H, baseContentH: newBCH)
                }
                withAnimation(.smooth(duration: 0.46)) {
                    levelIndex = newIndex
                    scale = newScale
                    offset = CGSize(width: 0, height: newOY)   // content packs from col 0 → edge-aligned
                }
                pinching = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { dragSuppressed = false }
            }
    }

    // MARK: - Vertical drag (scroll) with momentum
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
                let v = value.velocity.height
                let projected = offset.height + v * 0.42
                let target = clampY(projected, scale: scale, H: H, baseContentH: baseContentH)
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
