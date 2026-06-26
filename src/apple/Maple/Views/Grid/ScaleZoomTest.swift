// ScaleZoomTest.swift — THROWAWAY prototype (#1550), now on REAL photos.
//
// Scale-based grid zoom with content repacking + a delayed crossfade settle,
// driven over the real library (vm.assets via ThumbnailProvider / PhotoThumbnailCell):
//   - Each level T renders a T-column packing of ALL assets, scaled (single GPU
//     transform) so the zoom is smooth; vertical scroll is a clamped offset + momentum.
//   - WINDOWED: only the rows in/near the viewport are realized (manual placement
//     in a ZStack), because the custom transform container can't use LazyVGrid's
//     native windowing — rendering every thumbnail would choke a big library.
//   - The pinched asset is tracked + kept under the finger across the repack.
//   - On settle the new packing dissolves in at its final edge-aligned position
//     (no horizontal motion); the outgoing settles scale + fades out.
//
// Reachable via the temporary 🧪 button in LibraryGrid. DELETE once decided.

#if os(iOS)

import SwiftUI
import MapleCore

/// Prototype-local thumbnail cache (assetID → jpeg bytes). Shared across both
/// crossfade layers + all levels, so an asset loaded once renders SYNCHRONOUSLY
/// everywhere after — no placeholder flash when the packing repacks on zoom.
/// A class so inserts don't trigger SwiftUI re-renders.
private final class ThumbCache {
    var map: [String: Data] = [:]
}

/// Thumbnail cell that seeds from the shared cache synchronously (no placeholder
/// for already-loaded assets), falling back to an async load on a cache miss.
private struct CachedThumb: View {
    let asset: AssetRef
    let source: (any ImageSource)?
    let provider: ThumbnailProvider
    let cache: ThumbCache
    let cell: CGFloat

    @State private var loaded: Data?

    private var key: String { asset.stableID ?? asset.id.uuidString }

    var body: some View {
        ThumbnailImage(jpegData: loaded ?? cache.map[key], displayMode: .fill)
            .frame(width: cell, height: cell)
            .clipped()
            .task(id: asset.id) {
                if cache.map[key] != nil { return }   // cached → already shown, no reload
                let item = PhotoGridItem(local: asset, source: source, overlays: GridCellOverlays())
                let bytes = await provider.thumbnail(for: item.thumbnailSource)
                guard !Task.isCancelled else { return }
                if let bytes { cache.map[key] = bytes }
                loaded = bytes
            }
    }
}

struct ScaleZoomTest: View {
    let assets: [AssetRef]
    let source: (any ImageSource)?
    let provider: ThumbnailProvider
    let onClose: () -> Void

    private let levels = [9, 5, 3, 1]
    private let baseColumns = 9
    private let gap: CGFloat = 2

    private var total: Int { assets.count }

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

    // Shared thumbnail cache so repacked cells render cached thumbs synchronously.
    @State private var cache = ThumbCache()

    // Crossfade transition.
    @State private var transitioning = false
    @State private var fade: Double = 0
    @State private var outLevelIndex = 0
    @State private var tScale: CGFloat = 1

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
                    gridLayer(level: outLevelIndex, layerScale: tScale,
                              layerOffset: layerOffset(level: outLevelIndex, s: tScale, align: 0, cell: cell, pitch: pitch, H: H),
                              cell: cell, pitch: pitch, H: H)
                        .opacity(1 - fade)
                    gridLayer(level: levelIndex, layerScale: nScale,
                              layerOffset: layerOffset(level: levelIndex, s: nScale, align: 1, cell: cell, pitch: pitch, H: H),
                              cell: cell, pitch: pitch, H: H)
                        .opacity(fade)
                } else {
                    gridLayer(level: levelIndex, layerScale: scale, layerOffset: offset,
                              cell: cell, pitch: pitch, H: H)
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

    // MARK: - Grid layer (windowed: only visible rows realized)

    @ViewBuilder
    private func gridLayer(level: Int, layerScale: CGFloat, layerOffset: CGSize, cell: CGFloat, pitch: CGFloat, H: CGFloat) -> some View {
        let T = levels[level]
        let rowH = cell + gap
        let rows = rowCount(forT: T)
        // Content-space vertical window (undo scale + offset). Realize a full
        // viewport of rows ABOVE and BELOW so cells load ahead of being seen —
        // a tight buffer churns cells at the edges and flashes the placeholder.
        let yTop = (-layerOffset.height) / layerScale
        let yBot = (H - layerOffset.height) / layerScale
        let visibleRows = max(1, Int(ceil((yBot - yTop) / rowH)))
        let firstRow = max(0, Int(floor(yTop / rowH)) - visibleRows)
        let lastRow = min(rows - 1, Int(ceil(yBot / rowH)) + visibleRows)
        let contentW = CGFloat(T) * cell + CGFloat(T - 1) * gap

        ZStack(alignment: .topLeading) {
            if firstRow <= lastRow {
                ForEach(firstRow...lastRow, id: \.self) { r in
                    ForEach(0..<T, id: \.self) { c in
                        let idx = r * T + c
                        if idx < total {
                            CachedThumb(asset: assets[idx], source: source, provider: provider, cache: cache, cell: cell)
                                .offset(x: CGFloat(c) * pitch, y: CGFloat(r) * rowH)
                        }
                    }
                }
            }
        }
        .frame(width: contentW, height: baseContentHeight(forT: T, cell: cell), alignment: .topLeading)
        .scaleEffect(layerScale, anchor: .topLeading)
        .offset(layerOffset)
    }

    // MARK: - Math

    private func rowCount(forT T: Int) -> Int { max(1, Int(ceil(Double(total) / Double(T)))) }

    private func baseContentHeight(forT T: Int, cell: CGFloat) -> CGFloat {
        let rows = rowCount(forT: T)
        return CGFloat(rows) * cell + CGFloat(max(rows - 1, 0)) * gap
    }

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
        let w = (focalScreen.x - cx * s) * (1 - align)
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
                    withAnimation(.smooth(duration: 0.30)) {
                        scale = newScale
                        offset = layerOffset(level: levelIndex, s: newScale, align: 1, cell: cell, pitch: pitch, H: H)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { dragSuppressed = false }
                    return
                }

                outLevelIndex = levelIndex
                levelIndex = newIndex
                tScale = liveScale
                fade = 0
                transitioning = true
                withAnimation(.smooth(duration: 0.46)) {
                    tScale = newScale
                }
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
            Text("\(targetColumns)-wide  \(total) photos  focal \(focalImage.map(String.init) ?? "-")")
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
