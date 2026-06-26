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
// M2: `level` Binding<GridZoomLevel>; writes back on settle. M3: cross-platform
// MagnifyGesture; external level changes drive the settle from viewport centre;
// `onAppearItem` for lazy priming.
//
// Fixes (#1570 scalezoom-fixes):
//   1 — stuck crossfade: asyncAfter finalization + transitionToken + suppressLevelObserver
//   2 — accidental opens: lastGestureEnd time guard + scroll threshold 8->4pt
//   3 — always open at .comfortable (3-wide) regardless of persisted value
//   4 — content inset: full ignoresSafeArea() + topInset so grid opens below
//       bars and scrolls under them

import SwiftUI
import MapleCore

// MARK: - Geometry snapshot

/// Geometry snapshot for external-level settle animations (toolbar +/-, ⌘±).
private struct GridGeometry {
    let W: CGFloat
    let H: CGFloat
    let cell: CGFloat
    let pitch: CGFloat
    let topInset: CGFloat

    static let zero = GridGeometry(W: 0, H: 0, cell: 0, pitch: 0, topInset: 0)
}

// MARK: - ScaleZoomGrid

struct ScaleZoomGrid<Element: Identifiable>: View {

    // MARK: Inputs

    let data: [Element]
    /// Persisted zoom level. The component maps GridZoomLevel <-> internal
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
    /// Records end of each pinch/drag; tap guard rejects taps within 0.5s.
    @State private var lastGestureEnd: Date = .distantPast
    /// One-time initialisation guard: set the resting scale/offset for the
    /// persisted level on first layout (needs geometry, so done inside the
    /// GeometryReader rather than a top-level onAppear).
    @State private var didInit = false

    // MARK: Crossfade transition

    @State private var transitioning = false
    @State private var fade: Double = 0
    @State private var outLevelIndex = 0
    @State private var tScale: CGFloat = 1
    /// Monotonically-increasing; asyncAfter finalizer only commits if token matches.
    @State private var transitionToken: Int = 0

    // MARK: Observer-suppression guard

    /// Suppresses `.onChange(of: level)` during internal write-backs to stop re-entry.
    @State private var suppressLevelObserver = false

    // MARK: External-animation guard (M3)

    /// Guards `.onChange(of: level)` write-backs from re-triggering settleToLevel.
    @State private var externalAnimating = false

    private var targetColumns: Int { levels[levelIndex] }

    // MARK: - Level mapping

    private func indexFor(_ zoomLevel: GridZoomLevel) -> Int {
        levels.firstIndex(of: zoomLevel.phoneColumns) ?? 2
    }

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
                let topInset = geo.safeAreaInsets.top

            ZStack(alignment: .topLeading) {
                if transitioning {
                    let nScale = levelScale(levels[levelIndex], cell: cell, W: W)
                    gridLayer(level: outLevelIndex,
                              layerScale: tScale,
                              layerOffset: layerOffset(level: outLevelIndex, s: tScale, align: 0,
                                                       cell: cell, pitch: pitch, H: H,
                                                       topInset: topInset),
                              cellSize: cell, pitch: pitch, H: H)
                        .opacity(1 - fade)
                    gridLayer(level: levelIndex,
                              layerScale: nScale,
                              layerOffset: layerOffset(level: levelIndex, s: nScale, align: 1,
                                                       cell: cell, pitch: pitch, H: H,
                                                       topInset: topInset),
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
            .gesture(magnify(W: W, H: H, pitch: pitch, cell: cell, topInset: topInset))
            .simultaneousGesture(verticalDrag(cell: cell, H: H, topInset: topInset))
            // First layout: always open at .comfortable (3-wide) regardless of
            // the persisted level — consistent, predictable open state (#1570 Issue 3).
            .onAppear {
                guard !didInit, W > 0 else { return }
                didInit = true
                // Always open at 3-wide (.comfortable), ignoring the persisted value.
                let idx = indexFor(.comfortable)
                levelIndex = idx
                scale = levelScale(levels[idx], cell: cell, W: W)
                // Issue 4: rest below the top bars at topInset (not 0).
                offset = CGSize(width: 0, height: topInset)
                // Suppress the observer so this write-back doesn't trigger a settle.
                suppressLevelObserver = true
                level = .comfortable
                suppressLevelObserver = false
            }
            // Sync internal levelIndex when the external binding changes
            // (e.g. toolbar +/- in M3). Guard against recursive updates
            // triggered by our own write-backs (pinch settle or external settle).
            .onChange(of: level) { _, newLevel in
                guard !suppressLevelObserver else { return }
                let newIdx = indexFor(newLevel)
                guard newIdx != levelIndex, !pinching, !transitioning else { return }
                // External change — run the full settle animation anchored on
                // the viewport centre (no finger focal point available).
                settleToLevel(newIdx,
                              geo: GridGeometry(W: W, H: H, cell: cell, pitch: pitch,
                                                topInset: topInset))
            }
        }
        // Full-screen ignoresSafeArea so content can scroll under the translucent
        // nav/status bars. The topInset from safeAreaInsets.top (still reported
        // accurately) is used as the content rest-offset so the grid OPENS below
        // the bars, but scrolling lets content travel under them (#1570 Issue 4).
        .ignoresSafeArea()
        .background(Color.black)
    }

    // MARK: - Grid layer (windowed: only visible rows realized)

    @ViewBuilder
    private func gridLayer(level: Int, layerScale: CGFloat, layerOffset: CGSize,
                            cellSize: CGFloat, pitch: CGFloat, H: CGFloat) -> some View {
        let T = levels[level]
        let rowH = cellSize + gap
        let rows = rowCount(forT: T)
            // Windowed realisation: ±1 viewport buffer so cells load ahead.
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
                    // Time-based guard: reject taps within 0.5s of any gesture end.
                    let recentGesture = Date().timeIntervalSince(lastGestureEnd) < 0.5
                    guard !tapBlocked, !transitioning, !pinching, !dragging,
                          !recentGesture else { return }
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

    /// Clamp vertical scroll. Upper bound = topInset (content rests below bars);
    /// lower bound lets the last row reach the screen bottom.
    private func clampY(_ y: CGFloat, scale s: CGFloat, H: CGFloat,
                         baseContentH: CGFloat, topInset: CGFloat) -> CGFloat {
        let contentPx = baseContentH * s
        // maxDown: how far we can scroll before the bottom of content hits the
        // screen bottom. Anchored from topInset (not 0) because the content
        // starts at topInset at rest.
        let maxDown = max(0, contentPx - (H - topInset))
        return min(topInset, max(topInset - maxDown, y))
    }

    /// Image index under a content-space point (row, col).
    private func imageIndex(r: Int, c: Int, T: Int) -> Int? {
        guard c >= 0, c < T else { return nil }
        let g = r * T + c   // global slot
        return g < total ? g : nil
    }

    private func layerOffset(level: Int, s: CGFloat, align: Double,
                              cell: CGFloat, pitch: CGFloat, H: CGFloat,
                              topInset: CGFloat) -> CGSize {
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
                      height: clampY(focalScreen.y - cy * s, scale: s, H: H,
                                     baseContentH: bch, topInset: topInset))
    }

    // MARK: - Transition finalization

    /// Deterministic settle finalizer via asyncAfter. Token-guarded so a newer
    /// transition started between kick-off and the timer fire doesn't clobber state.
    private func finalizeTransition(
        token: Int, newIndex: Int, newScale: CGFloat,
        cell: CGFloat, pitch: CGFloat, H: CGFloat, topInset: CGFloat
    ) {
        guard transitioning, transitionToken == token else { return }
        scale = newScale
        offset = layerOffset(level: newIndex, s: newScale, align: 1,
                             cell: cell, pitch: pitch, H: H, topInset: topInset)
        transitioning = false
        fade = 0
        externalAnimating = false
        // Write back through binding — suppress observer so this doesn't re-enter.
        suppressLevelObserver = true
        level = zoomLevelFor(newIndex)
        suppressLevelObserver = false
    }

    // MARK: - External level change settle (M3)

    /// Full crossfade settle for external `level` changes (toolbar +/-, ⌘±).
    /// Anchors on the viewport centre — no finger position available.
    private func settleToLevel(_ newIndex: Int, geo: GridGeometry) {
        guard !transitioning, !pinching, newIndex != levelIndex else { return }

        let W = geo.W
        let H = geo.H
        let cell = geo.cell
        let pitch = geo.pitch
        let topInset = geo.topInset

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

        // Bump the token — any previously-scheduled finalizer for a prior
        // transition will see a stale token and no-op.
        let token = transitionToken + 1
        transitionToken = token

        withAnimation(.smooth(duration: 0.46)) {
            tScale = newScale
        }
        withAnimation(.smooth(duration: 1.0).delay(0.2)) {
            fade = 1
        }

        // Deterministic finalization: 0.2s delay + 1.0s fade + 0.1s buffer = 1.3s.
        // Does not rely on withAnimation(completion:) which can fire late or be
        // interrupted — this fires unconditionally and is token-guarded.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) {
            finalizeTransition(token: token, newIndex: newIndex, newScale: newScale,
                               cell: cell, pitch: pitch, H: H, topInset: topInset)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            dragSuppressed = false
        }
    }

    // MARK: - Pinch (zoom + crossfade settle)

    private func magnify(W: CGFloat, H: CGFloat, pitch: CGFloat, cell: CGFloat,
                          topInset: CGFloat) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                if !pinching {
                    // Issue 1 re-entrancy guard: a new pinch starting while a
                    // crossfade is in-flight must NOT stack a second transition.
                    // Commit to the in-flight target level immediately, then start
                    // the new pinch from that settled state.
                    if transitioning {
                        let inFlightIndex = levelIndex
                        let inFlightScale = levelScale(levels[inFlightIndex], cell: cell, W: W)
                        // Invalidate the pending asyncAfter by bumping the token.
                        transitionToken += 1
                        scale = inFlightScale
                        offset = layerOffset(level: inFlightIndex, s: inFlightScale, align: 1,
                                             cell: cell, pitch: pitch, H: H, topInset: topInset)
                        transitioning = false
                        fade = 0
                        externalAnimating = false
                        suppressLevelObserver = true
                        level = zoomLevelFor(inFlightIndex)
                        suppressLevelObserver = false
                    }
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
                                     cell: cell, pitch: pitch, H: H, topInset: topInset)
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
                // Issue 2: record gesture end for the 0.5s time-based tap guard.
                lastGestureEnd = Date()

                if newIndex == levelIndex {
                    // No level change — animate back to the resting scale.
                    withAnimation(.smooth(duration: 0.30)) {
                        scale = newScale
                        offset = layerOffset(level: levelIndex, s: newScale, align: 1,
                                             cell: cell, pitch: pitch, H: H, topInset: topInset)
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

                // Issue 1: bump the token — any prior pending finalizer no-ops.
                let token = transitionToken + 1
                transitionToken = token

                withAnimation(.smooth(duration: 0.46)) {
                    tScale = newScale
                }
                withAnimation(.smooth(duration: 1.0).delay(0.2)) {
                    fade = 1
                }

                // Deterministic finalization — does NOT rely on withAnimation(completion:).
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) {
                    finalizeTransition(token: token, newIndex: newIndex, newScale: newScale,
                                       cell: cell, pitch: pitch, H: H, topInset: topInset)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    dragSuppressed = false
                    tapBlocked = false
                }
            }
    }

    // MARK: - Vertical drag (scroll) with momentum

    private func verticalDrag(cell: CGFloat, H: CGFloat,
                               topInset: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                guard !pinching, !dragSuppressed, !transitioning else { return }
                if !dragging { dragging = true; dragBaseY = offset.height }
                // A real scroll (not a tap-jiggle) blocks taps so a finger-up
                // after scrolling doesn't open an image. Threshold lowered from
                // 8pt -> 4pt for sharper detection (#1570 Issue 2).
                if abs(value.translation.height) > 4 { tapBlocked = true }
                let bch = baseContentHeight(forT: targetColumns, cellSize: cell)
                offset.height = clampY(dragBaseY + value.translation.height,
                                       scale: scale, H: H, baseContentH: bch,
                                       topInset: topInset)
            }
            .onEnded { value in
                guard !pinching, !dragSuppressed, !transitioning else {
                    dragging = false; return
                }
                dragging = false
                // Issue 2: record gesture end for the 0.5s time-based tap guard.
                lastGestureEnd = Date()
                let v = value.velocity.height
                let bch = baseContentHeight(forT: targetColumns, cellSize: cell)
                // Stronger momentum so flicks coast further (faster browsing).
                let target = clampY(offset.height + v * 0.7, scale: scale, H: H,
                                    baseContentH: bch, topInset: topInset)
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
