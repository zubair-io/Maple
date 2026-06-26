// GridZoomGesture.swift — pinch-to-zoom modifier for photo grids (#1550).
//
// Encapsulates the `MagnifyGesture` so grid surfaces (LibraryGrid, BrowseGrid)
// get identical focal-anchored behaviour. CloudTimelineView uses the simple
// `gridZoomPinch` variant (plain resize, no focal state).
//
// Two public modifiers:
//
//   `.gridZoomPinchFocal(level:isPinching:startAnchor:onEnded:)`
//       Focal-aware. The surface sets `isPinching=true` on the first changed
//       event (enabling frame publishing in PhotoGrid), captures `startAnchor`,
//       and receives a single `onEnded(startAnchor, snappedLevel)` callback
//       where it calls `resolveFocalZoom(...)` and does the deferred scrollTo.
//       This keeps the gesture modifier free of vm/proxy references.
//
//   `.gridZoomPinch(level:)`
//       Simple variant (CloudTimelineView + backward compat). Plain level snap,
//       no focal state.
//
// `resolveFocalZoom(...)` is a free function so both surfaces share the logic.
//
// `.simultaneousGesture` lets the pinch coexist with the scroll view's pan.

import SwiftUI
import MapleCore

// MARK: - resolveFocalZoom

/// Pure resolver: given the frozen cell-frame snapshot and surface context,
/// compute the focal anchoring parameters. Both LibraryGrid and BrowseGrid
/// call this from their `onEnded` handler.
///
/// - Parameters:
///   - startAnchor:        `MagnifyGesture.Value.startAnchor` (unit point in the viewport).
///   - frozenFrames:       Snapshot of `CellFramePreferenceKey` taken on first `onChanged`.
///   - viewportSize:       Size of the ScrollView viewport (from GeometryReader / onGeometryChange).
///   - orderedIDs:         Asset IDs in display order (vm.assets.map { $0.id }).
///   - leadingFolderCount: Number of folder cells in the `leading:` slot (L).
///   - selectedID:         The surface's current `vm.selectedID` (fallback for gutter pinch).
///   - oldLevel:           Level before the pinch gesture ended.
///   - newLevel:           Level the grid will snap to.
///   - contentWidth:       Measured width of the grid content area.
///   - layout:             Current `MapleLayout` environment value.
///   - measuredColumnCount: Column count inferred from distinct first-row x-origins in
///                           `frozenFrames` (nil → fall back to adaptive formula).
///
/// Returns `(focalID, leadingSpacerCount, focalYUnit)`. `focalID == nil` means
/// no focal → plain resize (spacerCount 0).
func resolveFocalZoom(
    startAnchor: UnitPoint,
    frozenFrames: [AnyHashable: CGRect],
    viewportSize: CGSize,
    orderedIDs: [AssetRef.ID],
    leadingFolderCount: Int,
    selectedID: AssetRef.ID?,
    oldLevel: GridZoomLevel,
    newLevel: GridZoomLevel,
    contentWidth: CGFloat,
    layout: MapleLayout,
    measuredColumnCount: Int?
) -> (focalID: AssetRef.ID?, leadingSpacerCount: Int, focalYUnit: CGFloat) {
    let noFocal: (AssetRef.ID?, Int, CGFloat) = (nil, 0, 0.5)

    // --- Hit-test: which cell contains the pinch point? ---
    let viewportPoint = CGPoint(
        x: startAnchor.x * viewportSize.width,
        y: startAnchor.y * viewportSize.height
    )

    // frozenFrames keys are AnyHashable(AssetRef.ID = UUID) — unwrap via `.base as? UUID`.
    let hitID: AssetRef.ID? = frozenFrames
        .first { _, rect in rect.contains(viewportPoint) }
        .flatMap { $0.key.base as? AssetRef.ID }

    // Fallback chain: hit → selectedID → nearest-to-center cell.
    let resolvedID: AssetRef.ID
    if let hit = hitID {
        resolvedID = hit
    } else if let sel = selectedID {
        resolvedID = sel
    } else {
        let center = CGPoint(x: viewportSize.width / 2, y: viewportSize.height / 2)
        let nearest = frozenFrames
            .compactMap { key, rect -> (AssetRef.ID, CGFloat)? in
                guard let aid = key.base as? AssetRef.ID else { return nil }
                let dx = rect.midX - center.x
                let dy = rect.midY - center.y
                return (aid, dx * dx + dy * dy)
            }
            .min { $0.1 < $1.1 }
            .map { $0.0 }
        guard let nearest else { return noFocal }
        resolvedID = nearest
    }

    // --- Focal's position in the ordered data array ---
    guard let focalIndex = orderedIDs.firstIndex(of: resolvedID) else { return noFocal }

    // Global slot: leading folders + index in photo data.
    let globalSlot = leadingFolderCount + focalIndex

    // --- Column counts ---
    let gap: CGFloat = layout == .phone ? 2 : 4

    let nOld: Int
    let nNew: Int
    if layout == .phone {
        nOld = oldLevel.phoneColumns
        nNew = newLevel.phoneColumns
    } else {
        // Prefer measured first-row column count (avoids off-by-one vs SwiftUI packing).
        // nOld uses the measured value; nNew uses the formula (new layout not yet rendered).
        nOld = measuredColumnCount
            ?? FocalZoomMath.adaptiveColumnCount(contentWidth: contentWidth, minCell: oldLevel.desktopCellWidth, gap: gap)
        nNew = FocalZoomMath.adaptiveColumnCount(contentWidth: contentWidth, minCell: newLevel.desktopCellWidth, gap: gap)
    }

    // Lower rawValue = bigger cells = zooming in.
    let zoomingIn = newLevel.rawValue < oldLevel.rawValue
    let colOld = FocalZoomMath.positiveMod(globalSlot, max(nOld, 1))
    let targetCol = FocalZoomMath.targetColumn(colOld: colOld, nOld: nOld, nNew: nNew, zoomingIn: zoomingIn)

    // Clamp spacers to 0 when focal is already in row 0 (avoids a visible top gap).
    let rawSpacers = FocalZoomMath.leadingSpacers(globalSlot: globalSlot, nNew: nNew, targetColumn: targetCol)
    let spacerCount = globalSlot < nNew ? 0 : rawSpacers

    // --- Focal Y unit (fractional midY in the viewport) ---
    let focalFrame = frozenFrames[AnyHashable(resolvedID)]
    let focalYUnit: CGFloat
    if let frame = focalFrame, viewportSize.height > 0 {
        focalYUnit = min(max(frame.midY / viewportSize.height, 0), 1)
    } else {
        focalYUnit = 0.5
    }

    return (focalID: resolvedID, leadingSpacerCount: spacerCount, focalYUnit: focalYUnit)
}

// MARK: - GridZoomPinchFocal (focal-aware, used by LibraryGrid + BrowseGrid)

private struct GridZoomPinchFocal: ViewModifier {
    @Binding var level: GridZoomLevel
    @Binding var isPinching: Bool
    @Binding var startAnchor: UnitPoint

    /// Called once on gesture end. The surface resolves the FocalZoomRequest
    /// from its own cell-frame state and does the deferred scrollTo.
    let onEnded: (UnitPoint, GridZoomLevel) -> Void

    @State private var liveScale: CGFloat = 1
    @State private var blockingTaps = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(liveScale, anchor: startAnchor)
            .overlay {
                if blockingTaps {
                    Color.clear.contentShape(Rectangle())
                }
            }
            .simultaneousGesture(
                MagnifyGesture()
                    .onChanged { value in
                        if !isPinching {
                            // First event only: record the anchor, start frame publishing.
                            // Do NOT update startAnchor on subsequent events — we freeze
                            // the original pinch position (landmine #2: freeze, don't chase).
                            startAnchor = value.startAnchor
                            isPinching = true
                        }
                        blockingTaps = true

                        // Live feedback: track the pinch magnitude in BOTH directions
                        // so the grid visibly grows/shrinks under the fingers. (The
                        // earlier "no-overshoot clamp" pinned zoom-in to 1.0, which
                        // killed the growth and flickered across the threshold.)
                        liveScale = min(max(value.magnification, 0.55), 1.8)
                    }
                    .onEnded { value in
                        let snapped = value.magnification > 1.25 ? level.zoomedIn()
                                    : value.magnification < 0.8  ? level.zoomedOut()
                                    : level
                        // Surface resolves focal from its frozen frames.
                        onEnded(startAnchor, snapped)

                        withAnimation(.smooth(duration: 0.30)) {
                            liveScale = 1
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                            blockingTaps = false
                            isPinching = false
                        }
                    }
            )
    }
}

// MARK: - GridZoomPinchSimple (plain, no focal — CloudTimelineView)

private struct GridZoomPinchSimple: ViewModifier {
    @Binding var level: GridZoomLevel
    @State private var liveScale: CGFloat = 1
    @State private var anchor: UnitPoint = .center
    @State private var blockingTaps = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(liveScale, anchor: anchor)
            .overlay {
                if blockingTaps {
                    Color.clear.contentShape(Rectangle())
                }
            }
            .simultaneousGesture(
                MagnifyGesture()
                    .onChanged { value in
                        anchor = value.startAnchor
                        blockingTaps = true
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
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                            blockingTaps = false
                        }
                    }
            )
    }
}

// MARK: - Public extensions

extension View {
    /// Focal-aware pinch-to-zoom for LibraryGrid and BrowseGrid.
    ///
    /// The surface provides:
    /// - `level` binding — read and written (by `onEnded`) by the gesture.
    /// - `isPinching` binding — set true on first `onChanged`, false after settle.
    /// - `startAnchor` binding — UnitPoint of the pinch on first `onChanged`.
    /// - `onEnded` — called once on release with (frozenStartAnchor, snappedLevel).
    ///
    /// The surface calls `resolveFocalZoom(...)` inside `onEnded` where vm/proxy
    /// are in scope, then updates its spacer count and schedules `scrollTo`.
    func gridZoomPinchFocal(
        level: Binding<GridZoomLevel>,
        isPinching: Binding<Bool>,
        startAnchor: Binding<UnitPoint>,
        onEnded: @escaping (UnitPoint, GridZoomLevel) -> Void
    ) -> some View {
        modifier(GridZoomPinchFocal(
            level: level,
            isPinching: isPinching,
            startAnchor: startAnchor,
            onEnded: onEnded
        ))
    }

    /// Simple pinch-to-zoom — plain level snap, no focal anchoring.
    /// Used by CloudTimelineView (month-sectioned; focal is deferred).
    func gridZoomPinch(level: Binding<GridZoomLevel>) -> some View {
        modifier(GridZoomPinchSimple(level: level))
    }
}
