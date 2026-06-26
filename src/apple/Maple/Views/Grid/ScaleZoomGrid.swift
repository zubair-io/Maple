// ScaleZoomGrid.swift — reusable generic scale-zoom photo grid (#1570 M0/M2/M3).
//
// Generalises the validated interaction from ScaleZoomTest into a production
// component. All tuned numbers are preserved verbatim from the prototype:
//   levels [9, 5, 3, 1]  settle 0.46s  fade delay 0.2s + duration 1.0s
//   momentum v*0.42  scale clamps 0.08..12  window ±1 viewport
//   focal rounding toward pinch direction (no opposite bounce)
//
// API:
//   ScaleZoomGrid(
//       data:         [Element],             // photo items
//       level:        Binding<GridZoomLevel>, // persisted zoom level (M2+)
//       provider:     ThumbnailProvider,
//       makeItem:     (Element) -> PhotoGridItem,
//       onTap:        (Element) -> Void,
//       leadingCount: Int,                   // leading slot count (folders)
//       leading:      (Int) -> AnyView?      // leading cell view by slot index
//   )
// Optional: selection: Set<Element.ID>, multiSelectChecked: ((Element) -> Bool?)?,
//           displayMode: GridDisplayMode, onAppearItem: ((Element) -> Void)?
//
// Leading cells occupy global slots 0..<leadingCount; photo index f maps to
// global slot (leadingCount + f). This preserves today's leading-slot layout
// so folders zoom and scroll with the photos.
//
// Cells use PhotoThumbnailCell (with the M1 sync cache peek) — no placeholder
// flash for thumbnails already in the memory cache.
//
// M2: `level` is now a Binding<GridZoomLevel>. The component converts the
// GridZoomLevel to its internal levelIndex on appear and on change, and writes
// back through the binding whenever a settle completes. `displayMode` is
// threaded through to PhotoThumbnailCell.
//
// M3: `#if os(iOS)` guard removed — MagnifyGesture is cross-platform (trackpad
// pinch on macOS maps to the same gesture). External level changes (toolbar +/-,
// ⌘±) now run the full settle animation anchored on the viewport centre, using
// geometry captured on each layout pass. An `externalAnimating` flag prevents
// the onChange write-back from triggering a second animation cycle.
// `onAppearItem` added so BrowseGrid can call `onPrimeSession` when a cell
// enters the windowed realisation region.

import SwiftUI
import MapleCore

// MARK: - Geometry snapshot

/// Captured on each GeometryReader layout pass so external-level changes
/// (toolbar +/- , ⌘±) can drive the settle animation without being inside
/// the GeometryReader closure.
private struct GridGeometry {
    let W: CGFloat
    let H: CGFloat
    let cell: CGFloat
    let pitch: CGFloat

    static let zero = GridGeometry(W: 0, H: 0, cell: 0, pitch: 0)
}

// MARK: - ScaleZoomGrid

struct ScaleZoomGrid<Element: Identifiable>: View {

    // MARK: Inputs

    let data: [Element]
    /// Persisted zoom level. The component maps GridZoomLevel ↔ internal
    /// levelIndex via phoneColumns and writes back on each settle.
    @Binding var level: GridZoomLevel
    let provider: ThumbnailProvider
    let makeItem: (Element) -> PhotoGridItem
    let onTap: (Element) -> Void

    /// How thumbnails fill the square cell. Defaults to .fill (cover crop).
    var displayMode: GridDisplayMode = .fill

    /// Number of leading slots (folders) packed before the photo items.
    var leadingCount: Int = 0
    /// View factory for leading slots; receives the slot index (0..<leadingCount).
    /// Return `nil` to leave a slot empty.
    var leading: (Int) -> AnyView? = { _ in nil }

    /// Currently selected item IDs (single-select outline).
    var selection: Set<Element.ID> = []
    /// Multi-select badge state per element. When non-nil the element is in
    /// multi-select mode and renders a checkmark badge at top-trailing.
    var multiSelectChecked: ((Element) -> Bool?)? = nil

    /// Called when a photo element's cell enters the windowed realisation
    /// region. Use for lazy session priming or prefetch. Optional.
    var onAppearItem: ((Element) -> Void)? = nil

    // MARK: Fixed geometry

    private let levels = [9, 5, 3, 1]
    private let baseColumns = 9
    private let gap: CGFloat = 2

    private var total: Int { leadingCount + data.count }

    // MARK: Resting transform

    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var levelIndex: Int = 0
    @State private var focalImage: Int? = nil   // global slot index of focal cell

    // MARK: Gesture scratch

    @State private var pinching = false
    @State private var gestureStartScale: CGFloat = 1
    @State private var focalScreen: CGPoint = .zero
    @State private var focalFallback: CGPoint = .zero
    @State private var dragging = false
    @State private var dragBaseY: CGFloat = 0
    @State private var dragSuppressed = false
    /// Blocks cell taps during/after a pinch or a real scroll so a lingering
    /// finger doesn't open an image by mistake. Distinct from `dragSuppressed`
    /// (which gates the drag gesture) — this gates the cell `onTap`.
    @State private var tapBlocked = false
    /// One-time initialisation guard: set the resting scale/offset for the
    /// persisted level on first layout (needs geometry, so done inside the
    /// GeometryReader rather than a top-level onAppear).
    @State private var didInit = false

    // MARK: Crossfade transition

    @State private var transitioning = false
    @State private var fade: Double = 0
    @State private var outLevelIndex = 0
    @State private var tScale: CGFloat = 1

    // MARK: External-animation guard (M3)

    /// Set to true while the component is executing an externally-triggered
    /// level-change settle animation. Guards `.onChange(of: level)` so the
    /// write-back at the end of the settle doesn't trigger a second animation.
    @State private var externalAnimating = false

    private var targetColumns: Int { levels[levelIndex] }

    // MARK: - Level <-> binding mapping

    /// Convert a GridZoomLevel to the internal levelIndex.
    private func indexFor(_ zoomLevel: GridZoomLevel) -> Int {
        levels.firstIndex(of: zoomLevel.phoneColumns) ?? 2
    }

    /// Convert an internal levelIndex to a GridZoomLevel (falls back to .comfortable).
    private func zoomLevelFor(_ idx: Int) -> GridZoomLevel {
        let cols = levels[idx]
        return GridZoomLevel.allCases.first { $0.phoneColumns == cols } ?? .comfortable
    }

    // MARK: Body

    var body: some View {
        GeometryReader { geo in
            let W = geo.size.width
            let H = geo.size.height
            let cell = (W - gap * CGFloat(baseColumns - 1)) / CGFloat(baseColumns)
            let pitch = cell + gap

            ZStack(alignment: .topLeading) {
                if transitioning {
                    let nScale = levelScale(levels[levelIndex], cell: cell, W: W)
                    gridLayer(level: outLevelIndex,
                              layerScale: tScale,
                              layerOffset: layerOffset(level: outLevelIndex, s: tScale, align: 0,
                                                       cell: cell, pitch: pitch, H: H),
                              cellSize: cell, pitch: pitch, H: H)
                        .opacity(1 - fade)
                    gridLayer(level: levelIndex,
                              layerScale: nScale,
                              layerOffset: layerOffset(level: levelIndex, s: nScale, align: 1,
                                                       cell: cell, pitch: pitch, H: H),
                              cellSize: cell, pitch: pitch, H: H)
                        .opacity(fade)
                } else {
                    gridLayer(level: levelIndex, layerScale: scale, layerOffset: offset,
                              cellSize: cell, pitch: pitch, H: H)
                }
            }
            .frame(width: W, height: H, alignment: .topLeading)
            .clipped()
            .contentShape(Rectangle())
            .gesture(magnify(W: W, H: H, pitch: pitch, cell: cell))
            .simultaneousGesture(verticalDrag(cell: cell, H: H))
            // First layout: set the resting scale + offset for the persisted
            // level (not just levelIndex) so a non-dense level opens correctly
            // instead of rendering at the stale scale=1.
            .onAppear {
                guard !didInit, W > 0 else { return }
                didInit = true
                let idx = indexFor(level)
                levelIndex = idx
                scale = levelScale(levels[idx], cell: cell, W: W)
                offset = .zero   // top, edge-aligned
            }
            // Sync internal levelIndex when the external binding changes
            // (e.g. toolbar +/- in M3). Guard against recursive updates
            // triggered by our own write-backs (pinch settle or external settle).
            .onChange(of: level) { _, newLevel in
                let newIdx = indexFor(newLevel)
                guard newIdx != levelIndex, !pinching, !transitioning else { return }
                // External change — run the full settle animation anchored on
                // the viewport centre (no finger focal point available).
                settleToLevel(newIdx,
                              geo: GridGeometry(W: W, H: H, cell: cell, pitch: pitch))
            }
        }
        // Respect the top safe area (nav/status bar) so the grid doesn't open
        // overflowing under it; still extend under the bottom edge.
        .ignoresSafeArea(edges: .bottom)
        .background(Color.black)
    }

    // MARK: - Grid layer (windowed: only visible rows realized)

    @ViewBuilder
    private func gridLayer(level: Int, layerScale: CGFloat, layerOffset: CGSize,
                            cellSize: CGFloat, pitch: CGFloat, H: CGFloat) -> some View {
        let T = levels[level]
        let rowH = cellSize + gap
        let rows = rowCount(forT: T)
        // Content-space vertical window (undo scale + offset). Realize a full
        // viewport of rows above and below so cells load ahead of being seen —
        // a tight buffer churns cells at the edges and flashes the placeholder.
        let yTop = (-layerOffset.height) / layerScale
        let yBot = (H - layerOffset.height) / layerScale
        let visibleRows = max(1, Int(ceil((yBot - yTop) / rowH)))
        let firstRow = max(0, Int(floor(yTop / rowH)) - visibleRows)
        let lastRow = min(rows - 1, Int(ceil(yBot / rowH)) + visibleRows)
        let contentW = CGFloat(T) * cellSize + CGFloat(T - 1) * gap

        ZStack(alignment: .topLeading) {
            if firstRow <= lastRow {
                ForEach(firstRow...lastRow, id: \.self) { r in
                    ForEach(0..<T, id: \.self) { c in
                        let g = r * T + c   // global slot index
                        if g < total {
                            cell(globalSlot: g, cellSize: cellSize)
                                .offset(x: CGFloat(c) * pitch, y: CGFloat(r) * rowH)
                        }
                    }
                }
            }
        }
        .frame(width: contentW, height: baseContentHeight(forT: T, cellSize: cellSize),
               alignment: .topLeading)
        .scaleEffect(layerScale, anchor: .topLeading)
        .offset(layerOffset)
    }

    // MARK: - Cell dispatch

    /// Render the correct content for a global slot: leading view or photo cell.
    @ViewBuilder
    private func cell(globalSlot g: Int, cellSize: CGFloat) -> some View {
        if g < leadingCount {
            // Leading slot (folder / album cell).
            if let view = leading(g) {
                view
                    .frame(width: cellSize, height: cellSize)
                    .clipped()
            } else {
                Color.clear
                    .frame(width: cellSize, height: cellSize)
            }
        } else {
            let f = g - leadingCount   // photo index into `data`
            let element = data[f]
            let item = makeItem(element)
            PhotoThumbnailCell(
                item: item,
                provider: provider,
                displayMode: displayMode,
                isSelected: selection.contains(element.id),
                multiSelectChecked: multiSelectChecked?(element),
                onTap: {
                    // Ignore taps during/just after a pinch or a real scroll.
                    guard !tapBlocked, !transitioning, !pinching else { return }
                    onTap(element)
                },
                onAppear: onAppearItem.map { cb in { cb(element) } }
            )
            .frame(width: cellSize, height: cellSize)
            .clipped()
        }
    }

    // MARK: - Math

    private func rowCount(forT T: Int) -> Int {
        max(1, Int(ceil(Double(total) / Double(T))))
    }

    private func baseContentHeight(forT T: Int, cellSize: CGFloat) -> CGFloat {
        let rows = rowCount(forT: T)
        return CGFloat(rows) * cellSize + CGFloat(max(rows - 1, 0)) * gap
    }

    private func levelScale(_ T: Int, cell: CGFloat, W: CGFloat) -> CGFloat {
        W / (CGFloat(T) * cell + CGFloat(T - 1) * gap)
    }

    private func clampY(_ y: CGFloat, scale s: CGFloat, H: CGFloat, baseContentH: CGFloat) -> CGFloat {
        let maxDown = max(0, baseContentH * s - H)
        return min(0, max(-maxDown, y))
    }

    /// Image index under a content-space point (row, col).
    private func imageIndex(r: Int, c: Int, T: Int) -> Int? {
        guard c >= 0, c < T else { return nil }
        let g = r * T + c   // global slot
        return g < total ? g : nil
    }

    private func layerOffset(level: Int, s: CGFloat, align: Double,
                              cell: CGFloat, pitch: CGFloat, H: CGFloat) -> CGSize {
        let T = levels[level]
        let bch = baseContentHeight(forT: T, cellSize: cell)
        let cx: CGFloat
        let cy: CGFloat
        if let g = focalImage {
            cx = CGFloat(g % T) * pitch + cell / 2
            cy = CGFloat(g / T) * (cell + gap) + cell / 2
        } else {
            cx = focalFallback.x
            cy = focalFallback.y
        }
        let w = (focalScreen.x - cx * s) * (1 - align)
        return CGSize(width: w,
                      height: clampY(focalScreen.y - cy * s, scale: s, H: H, baseContentH: bch))
    }

    // MARK: - External level change settle (M3)

    /// Runs the full two-layer crossfade settle when the `level` binding is
    /// mutated externally (toolbar +/-, ⌘±). Uses the viewport centre as the
    /// focal point since no finger position is available.
    ///
    /// Guards against double-animate: `externalAnimating` is set true for the
    /// duration of the settle; the `.onChange(of: level)` guard stops re-entry
    /// because `transitioning` is true throughout.
    private func settleToLevel(_ newIndex: Int, geo: GridGeometry) {
        guard !transitioning, !pinching, newIndex != levelIndex else { return }

        let W = geo.W
        let H = geo.H
        let cell = geo.cell
        let pitch = geo.pitch

        // Anchor on viewport centre — no finger focal available.
        let centerX = W / 2
        let centerY = H / 2
        focalScreen = CGPoint(x: centerX, y: centerY)
        let cpX = (centerX - offset.width) / scale
        let cpY = (centerY - offset.height) / scale
        focalFallback = CGPoint(x: cpX, y: cpY)
        focalImage = imageIndex(r: Int(cpY / (cell + gap)),
                                c: Int(cpX / pitch),
                                T: targetColumns)

        let liveScale = scale
        let newScale = levelScale(levels[newIndex], cell: cell, W: W)

        outLevelIndex = levelIndex
        levelIndex = newIndex
        tScale = liveScale
        fade = 0
        transitioning = true
        externalAnimating = true

        withAnimation(.smooth(duration: 0.46)) {
            tScale = newScale
        }
        withAnimation(.smooth(duration: 1.0).delay(0.2)) {
            fade = 1
        } completion: {
            scale = newScale
            offset = layerOffset(level: newIndex, s: newScale, align: 1,
                                 cell: cell, pitch: pitch, H: H)
            transitioning = false
            fade = 0
            externalAnimating = false
            // Write the settled level back through the binding so the caller
            // can persist it. The onChange guard (`newIdx != levelIndex`) stops
            // re-entry since levelIndex already matches the new level.
            level = zoomLevelFor(newIndex)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            dragSuppressed = false
        }
    }

    // MARK: - Pinch (zoom + crossfade settle)

    private func magnify(W: CGFloat, H: CGFloat, pitch: CGFloat, cell: CGFloat) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                if !pinching {
                    pinching = true
                    dragSuppressed = true
                    tapBlocked = true
                    gestureStartScale = scale
                    focalScreen = CGPoint(x: value.startAnchor.x * W,
                                         y: value.startAnchor.y * H)
                    let cp = CGPoint(x: (focalScreen.x - offset.width) / scale,
                                     y: (focalScreen.y - offset.height) / scale)
                    focalFallback = cp
                    focalImage = imageIndex(r: Int(cp.y / (cell + gap)),
                                            c: Int(cp.x / pitch),
                                            T: targetColumns)
                }
                let mag = min(max(value.magnification, 0.08), 12)
                scale = gestureStartScale * mag
                offset = layerOffset(level: levelIndex, s: scale, align: 0,
                                     cell: cell, pitch: pitch, H: H)
            }
            .onEnded { value in
                let mag = value.magnification
                let liveScale = scale
                let newIndex: Int
                if mag > 1.05 {
                    // Pinching out -> fewer columns (zoom in). Pick the first
                    // level whose computed scale is >= current live scale.
                    var idx = levels.count - 1
                    for i in 0..<levels.count
                    where levelScale(levels[i], cell: cell, W: W) >= liveScale {
                        idx = i; break
                    }
                    newIndex = idx
                } else if mag < 0.95 {
                    // Pinching in -> more columns (zoom out). Pick the last
                    // level whose computed scale is <= current live scale.
                    var idx = 0
                    for i in 0..<levels.count
                    where levelScale(levels[i], cell: cell, W: W) <= liveScale {
                        idx = i
                    }
                    newIndex = idx
                } else {
                    newIndex = levelIndex
                }
                let newScale = levelScale(levels[newIndex], cell: cell, W: W)
                pinching = false

                if newIndex == levelIndex {
                    // No level change — animate back to the resting scale.
                    withAnimation(.smooth(duration: 0.30)) {
                        scale = newScale
                        offset = layerOffset(level: levelIndex, s: newScale, align: 1,
                                             cell: cell, pitch: pitch, H: H)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        dragSuppressed = false
                    }
                    return
                }

                // Level change: two-layer crossfade settle.
                // 1. The outgoing layer scales to the resting scale (.smooth 0.46s).
                // 2. After a 0.2s delay the incoming layer fades in at its final
                //    edge-aligned position (1.0s fade). No horizontal motion.
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
                    offset = layerOffset(level: newIndex, s: newScale, align: 1,
                                         cell: cell, pitch: pitch, H: H)
                    transitioning = false
                    fade = 0
                    // Write the settled level back through the binding so
                    // the caller can persist it (M2+).
                    level = zoomLevelFor(newIndex)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    dragSuppressed = false
                    tapBlocked = false
                }
            }
    }

    // MARK: - Vertical drag (scroll) with momentum

    private func verticalDrag(cell: CGFloat, H: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                guard !pinching, !dragSuppressed, !transitioning else { return }
                if !dragging { dragging = true; dragBaseY = offset.height }
                // A real scroll (not a tap-jiggle) blocks taps so a finger-up
                // after scrolling doesn't open an image.
                if abs(value.translation.height) > 8 { tapBlocked = true }
                let bch = baseContentHeight(forT: targetColumns, cellSize: cell)
                offset.height = clampY(dragBaseY + value.translation.height,
                                       scale: scale, H: H, baseContentH: bch)
            }
            .onEnded { value in
                guard !pinching, !dragSuppressed, !transitioning else {
                    dragging = false; return
                }
                dragging = false
                let v = value.velocity.height
                let bch = baseContentHeight(forT: targetColumns, cellSize: cell)
                // Stronger momentum so flicks coast further (faster browsing).
                let target = clampY(offset.height + v * 0.7, scale: scale, H: H, baseContentH: bch)
                let dur = min(max(abs(v) / 1200, 0.3), 2.2)
                withAnimation(.easeOut(duration: dur)) {
                    offset.height = target
                }
                // Keep taps blocked through the momentum coast, then release.
                if tapBlocked {
                    DispatchQueue.main.asyncAfter(deadline: .now() + dur + 0.15) {
                        tapBlocked = false
                    }
                }
            }
    }
}
