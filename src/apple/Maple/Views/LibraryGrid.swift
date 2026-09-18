// LibraryGrid.swift — responsive-program S2 (#623). Responsive photo
// grid for the Library tab.
//
// Spec: docs/design/responsive-program/s2-library-grid.md.
//
// Pinch-to-resize (Photos-style): the grid sits in one of a few column
// tiers (`LibraryGridZoom.columnTiers`, persisted under
// `cm.library.gridColumns`). A pinch moves continuously between tiers — the
// cells grow or shrink and re-flow under the fingers, the photo under the
// pinch stays put, a tick fires as the nearest tier changes, and release
// springs to the nearest tier. A `LazyVGrid` cannot be re-laid out
// continuously, so for the duration of a pinch the lazy grid is hidden and
// the visible slice of cells is drawn by `InterpolatedGridLayout`, whose
// per-cell frames blend between the two tiers the pinch is between. When
// the spring settles, the lazy grid switches to that tier and the scroll
// offset is shifted by exactly what the focal photo moved, so swapping the
// overlay out is invisible.
//
// Preview hand-off: a tap zooms the tile open (system zoom transition, see
// `PreviewDestination`); paging in Preview moves `vm.selectedID`, and the
// grid scrolls that photo's tile into view while it is covered, so the
// pop always has a live tile to shrink back into.

#if os(iOS)

import SwiftUI
import MapleCore
#if canImport(UIKit)
import UIKit
#endif

struct LibraryGrid: View {

    let vm: BrowseViewModel
    let source: (any ImageSource)?
    @Binding var sessions: [AssetRef.ID: EditSession]
    @Binding var displayMode: GridDisplayMode
    let transitionNamespace: Namespace.ID?

    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    /// Tap on a sub-folder tile — drills the grid into that folder.
    let onNavigateFolder: (URL) -> Void
    /// Fired by the empty state's "Connect" button when `vm.photosAuthNeeded`
    /// is true. Same closure `BrowseGrid` gets on Mac / iPad — without it the
    /// panel renders disabled and the phone has no route to the system
    /// permission prompt at all (#2924). `nil` in previews.
    var onGrantPhotosAccess: (() -> Void)? = nil

    /// Local-only thumbnail provider.
    @State private var provider = ThumbnailProvider.local()

    /// Persisted column tier. Read through `columns` so a stale value from
    /// an older tier list can never produce an unknown layout.
    @AppStorage("cm.library.gridColumns") private var storedColumns = LibraryGridZoom.defaultColumns
    private var columns: Int { LibraryGridZoom.validatedColumns(storedColumns) }

    /// The live pinch, if one is in progress (or springing to rest).
    @State private var pinch: PinchSession?
    /// Flips back to false when the magnify gesture ends OR is cancelled by
    /// the system — `onEnded` alone never fires for a cancellation, which
    /// would leave the overlay up for good.
    @GestureState private var isMagnifying = false
    @State private var scrollPosition = ScrollPosition()
    /// Scroll geometry the pinch reads on demand. A reference type on
    /// purpose: it is written every scroll frame, and a value in `@State`
    /// would re-render the whole grid on each one.
    @State private var scroll = ScrollGeometryBox()
    /// The id the grid itself just tapped, so the selection change that tap
    /// produces is not mistaken for Preview paging (which scrolls the grid).
    @State private var lastTappedID: AssetRef.ID?

    private static let scrollSpace = "library-grid-scroll"
    /// Release spring: quick enough to read as a snap, soft enough that a
    /// re-flow of every visible cell never overshoots into the next tier.
    private static let settleSpring = Animation.spring(response: 0.42, dampingFraction: 0.86)
    /// A hand-back shift smaller than this is sub-pixel: not worth a scroll.
    private static let minimumShift: CGFloat = 0.5

    /// Mirrors `BrowseGrid.isEmpty` — the empty state takes over only when
    /// the source yields neither images nor sub-folders.
    private var isEmpty: Bool {
        vm.assets.isEmpty && vm.subfolders.isEmpty
    }

    var body: some View {
        Group {
            // Zero images and zero sub-folders — hand the surface to the
            // shared overlay, which explains WHY it's empty (permission
            // panel / spinner / load error / no source picked). Before
            // #2924 this branch didn't exist and the phone rendered an
            // empty ScrollView, i.e. nothing.
            if isEmpty {
                BrowseEmptyState(vm: vm, onGrantPhotosAccess: onGrantPhotosAccess)
            } else {
                grid
            }
        }
        .accessibilityIdentifier("library-grid")
        // Maple surface behind the grid (incl. behind the translucent bars) so the
        // Library matches BrowseGrid / CloudSearchView — Copilot review on #1646.
        .background(MapleTokens.bg.ignoresSafeArea())
    }

    private var grid: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // Sub-folders first (Finder-style) in their own tile section
                    // above the images (#3099) — the same `FolderTile` the desktop
                    // BrowseGrid renders. Order stays reversed per #782 so the
                    // first-level folders read newest/last-first on the phone.
                    if !vm.subfolders.isEmpty {
                        FolderTileSection {
                            ForEach(Array(vm.subfolders.reversed()), id: \.self) { url in
                                FolderTile(url: url) { onNavigateFolder(url) }
                            }
                        }
                    }
                    PhotoGrid(
                        data: vm.assets,
                        columns: .fixed(columns, spacing: LibraryGridZoom.spacing),
                        provider: provider,
                        displayMode: displayMode,
                        selection: vm.selectedID.map { Set([$0]) } ?? [],
                        cellShape: cellShape,
                        transitionNamespace: transitionNamespace,
                        onAppearItem: { asset in
                            onPrimeSession(asset)
                            Task { await vm.loadMorePhotoKitIfNeeded(appearing: asset.id) }
                        },
                        onTap: { asset in
                            lastTappedID = asset.id
                            vm.selectedID = asset.id
                            #if canImport(UIKit)
                            UISelectionFeedbackGenerator().selectionChanged()
                            #endif
                            onOpenEditor(asset)
                        },
                        makeItem: makeItem
                    )
                    // While a pinch is live the lazy grid keeps the scroll
                    // content's size but the overlay does the drawing — and
                    // it must neither take taps (its cells sit at the old
                    // tier's positions) nor speak to VoiceOver twice.
                    .opacity(pinch == nil ? 1 : 0)
                    .allowsHitTesting(pinch == nil)
                    .accessibilityHidden(pinch != nil)
                    .overlay(alignment: .topLeading) {
                        if let pinch {
                            pinchOverlay(pinch)
                        }
                    }
                    .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(Self.scrollSpace)) }) { frame in
                        scroll.gridFrame = frame
                        // A rotation or split-view resize mid-pinch: the
                        // overlay's geometry is for the old width, so hand
                        // straight back to the lazy grid at the tier the
                        // pinch was heading for.
                        if let pinch, abs(frame.width - pinch.width) > 0.5 {
                            abandonPinch(pinch)
                        }
                    }
                }
                .padding(LibraryGridZoom.spacing)
            }
            .coordinateSpace(.named(Self.scrollSpace))
            .scrollPosition($scrollPosition)
            .onScrollGeometryChange(for: ScrollGeometry.self, of: { $0 }) { _, geometry in
                scroll.geometry = geometry
            }
            .simultaneousGesture(magnifyGesture)
            .onChange(of: isMagnifying) { _, active in
                // The system cancelled the pinch (a phone call, a system
                // gesture): settle from the last value we saw.
                if !active, let pinch, !pinch.isSettling {
                    settlePinch(magnification: pinch.lastMagnification)
                }
            }
            .onChange(of: vm.selectedID) { _, newID in
                guard let newID else { return }
                if newID == lastTappedID {
                    // Our own tap — the tile is under the finger; moving it now
                    // would move the zoom's source mid-open.
                    lastTappedID = nil
                    return
                }
                lastTappedID = nil
                // Preview paged to a sibling: bring its tile into view (the
                // grid is covered, so this is invisible) so the pop's zoom
                // has a live tile to land on. Minimal scroll, no animation.
                proxy.scrollTo(newID, anchor: nil)
            }
        }
    }

    private func makeItem(_ asset: AssetRef) -> PhotoGridItem {
        PhotoGridItem(local: asset, source: source, overlays: overlays(for: asset))
    }

    /// Full width in fill mode shows each photo whole, at its own aspect
    /// ratio; every other tier (and fit mode) keeps square tiles.
    private var cellShape: ThumbnailShape {
        columns == 1 && displayMode == .fill ? .native : .square
    }

    /// Height ÷ width of a photo's tile in the full-width tier — from its
    /// already-decoded thumbnail (the same bitmap the tile draws), square
    /// until that has landed. Must agree with `ThumbnailShape.native`.
    private func fullWidthAspect(of asset: AssetRef) -> CGFloat {
        guard displayMode == .fill,
              let image = ThumbnailDecoder.cachedImage(forKey: asset.stableID ?? asset.id.uuidString),
              image.width > 0
        else { return 1 }
        return CGFloat(image.height) / CGFloat(image.width)
    }

    // MARK: - Pinch-to-resize

    private var magnifyGesture: some Gesture {
        MagnifyGesture(minimumScaleDelta: 0.01)
            .updating($isMagnifying) { _, state, _ in state = true }
            .onChanged { value in
                // A new pinch while the last one is still springing: hand
                // the settled tier to the lazy grid now (a small jump to
                // where the spring was heading, never back to the old tier)
                // and start fresh on the next tick, once the grid has laid
                // out at that tier so the focal photo is read from live
                // geometry.
                if let settling = pinch, settling.isSettling {
                    swapPinchOut(settling, columns: settling.interpolation.settledColumns)
                    return
                }
                if pinch == nil {
                    beginPinch(at: value.startLocation)
                }
                updatePinch(magnification: value.magnification)
            }
            .onEnded { value in
                settlePinch(magnification: value.magnification)
            }
    }

    private func beginPinch(at startLocation: CGPoint) {
        let frame = scroll.gridFrame
        let assets = vm.assets
        guard frame.width > 0, !assets.isEmpty else { return }
        let geometry = LibraryGridZoom.Geometry(width: frame.width, count: assets.count) { index in
            fullWidthAspect(of: assets[index])
        }
        // The finger's point in grid coordinates, and the photo under it.
        let focal = CGPoint(x: startLocation.x - frame.minX, y: startLocation.y - frame.minY)
        guard let cell = geometry.focalCell(at: focal, columns: columns) else { return }
        // Draw, for every tier, the cells within two viewports of where that
        // tier puts the focal photo — the overlay keeps it under the fingers,
        // so nothing further away can come on screen, and the fingers may
        // pan a little.
        guard let slice = geometry.overlaySlice(
            focalIndex: cell.index, focalFraction: cell.fraction,
            reach: 2 * scroll.geometry.containerSize.height)
        else { return }
        let interpolation = LibraryGridZoom.interpolation(baseColumns: columns, magnification: 1, width: frame.width)
        pinch = PinchSession(
            baseColumns: columns,
            geometry: geometry,
            focalIndex: cell.index,
            focalFraction: cell.fraction,
            focalPoint: focal,
            slice: slice,
            interpolation: interpolation,
            nearestColumns: columns,
            lastMagnification: 1,
            isSettling: false,
            scrollRoom: scroll.room(geometry: geometry, baseColumns: columns, targetColumns: interpolation.to)
        )
    }

    private func updatePinch(magnification: CGFloat) {
        guard var session = pinch, !session.isSettling else { return }
        session.lastMagnification = magnification
        session.interpolation = LibraryGridZoom.interpolation(
            baseColumns: session.baseColumns, magnification: magnification, width: session.width)
        session.scrollRoom = scroll.room(
            geometry: session.geometry, baseColumns: session.baseColumns, targetColumns: session.interpolation.to)
        let nearest = LibraryGridZoom.nearestColumns(
            cellWidth: LibraryGridZoom.cellSize(columns: session.baseColumns, width: session.width) * magnification,
            width: session.width)
        if nearest != session.nearestColumns {
            session.nearestColumns = nearest
            #if canImport(UIKit)
            UISelectionFeedbackGenerator().selectionChanged()
            #endif
        }
        // Gesture-driven: no implicit animation, the fingers are the clock.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { pinch = session }
    }

    private func settlePinch(magnification: CGFloat) {
        guard var session = pinch, !session.isSettling else { return }
        session.lastMagnification = magnification
        let live = LibraryGridZoom.interpolation(
            baseColumns: session.baseColumns, magnification: magnification, width: session.width)
        let target = live.settledColumns
        session.isSettling = true
        // Spring the blend to the chosen tier (and any rubber-band back to
        // rest). `Interpolation` keeps `from`/`to` fixed for the spring;
        // only `progress`/`overscale` move — `InterpolatedGridLayout` and the
        // overlay's offset both animate from those.
        let rest = LibraryGridZoom.Interpolation(
            from: live.from, to: live.to, progress: target == live.to && live.to != live.from ? 1 : 0, overscale: 1)
        var start = session
        start.interpolation = live
        var end = session
        end.interpolation = rest
        var snap = Transaction()
        snap.disablesAnimations = true
        withTransaction(snap) { pinch = start }
        withAnimation(Self.settleSpring, completionCriteria: .logicallyComplete) {
            pinch = end
        } completion: {
            swapPinchOut(end, columns: target)
        }
        #if canImport(UIKit)
        if target != session.baseColumns {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
        #endif
    }

    /// Hand drawing back to the lazy grid at the settled tier. The grid's
    /// focal photo moves to its place in the new tier; shifting the scroll
    /// offset by that same amount puts it exactly where the overlay was
    /// showing it, so the swap is invisible. All in one non-animated
    /// transaction so the relayout and the scroll land on the same frame.
    private func swapPinchOut(_ session: PinchSession, columns target: Int) {
        guard pinch?.isSettling == true else { return }
        // The overlay is showing the focal photo `shift` points below where
        // the lazy grid will lay it out; scrolling up by that much puts the
        // real tile exactly there. (`shift` is already clamped to the room
        // the scroll view has, so this never asks for an offset it cannot
        // reach and then jumps.)
        let shift = session.overlayShift(at: session.interpolation)
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            storedColumns = target
            if abs(shift) > Self.minimumShift {
                scrollPosition.scrollTo(y: scroll.geometry.contentOffset.y - shift)
            }
            pinch = nil
        }
    }

    /// Drop the overlay without a hand-back shift (the geometry it was
    /// computed against is gone): the lazy grid lays out at the tier the
    /// pinch was heading for.
    private func abandonPinch(_ session: PinchSession) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            storedColumns = session.interpolation.settledColumns
            pinch = nil
        }
    }

    @ViewBuilder
    private func pinchOverlay(_ session: PinchSession) -> some View {
        let interpolation = session.interpolation
        let focalNow = session.focalPoint(at: interpolation)
        let baseHeight = session.geometry.gridHeight(columns: session.baseColumns)
        InterpolatedGridLayout(
            geometry: session.geometry,
            from: interpolation.from,
            to: interpolation.to,
            progress: interpolation.progress,
            firstIndex: session.slice.lowerBound
        ) {
            // Clamped: a PhotoKit page can land (or a folder reload shrink the
            // list) while the pinch is live.
            ForEach(Array(vm.assets[session.slice.clamped(to: vm.assets.indices)])) { asset in
                PhotoThumbnailCell(
                    item: makeItem(asset),
                    provider: provider,
                    displayMode: displayMode,
                    // Mid-way between two tiers a cell is neither square nor
                    // the photo's shape: it takes the blended frame as is.
                    shape: .proposed,
                    isSelected: vm.selectedID == asset.id,
                    onTap: {}
                )
            }
        }
        .frame(width: session.width, height: baseHeight, alignment: .topLeading)
        // Rubber-band past the end tiers: scale about the focal photo.
        .scaleEffect(
            interpolation.overscale,
            anchor: UnitPoint(x: focalNow.x / session.width, y: focalNow.y / max(1, baseHeight))
        )
        // Keep the focal photo under the fingers as the tiers re-flow: the
        // overlay slides by exactly what that photo moved — within the room
        // the scroll view will have at the target tier, so the hand-back to
        // the lazy grid can always reproduce it (at the very top of the grid
        // the photo drifts instead, as it does in Photos).
        .offset(y: session.overlayShift(at: interpolation))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    // MARK: - Overlay derivation

    private func overlays(for asset: AssetRef) -> GridCellOverlays {
        let session = sessions[asset.id]
        let cullFlag = session?.culling.flag ?? .none
        return GridCellOverlays(
            rating: session?.culling.stars ?? 0,
            flag: cullFlag == .none ? nil : cullFlag,
            sync: nil,
            isVideo: false,
            style: .phone,
            hidden: session?.culling.hidden ?? false
        )
    }
}

// MARK: - PinchSession

/// Everything a live pinch needs, captured when it begins.
private struct PinchSession {
    let baseColumns: Int
    /// Every tier's layout for the grid as it was when the pinch began.
    let geometry: LibraryGridZoom.Geometry
    var width: CGFloat { geometry.width }
    /// The photo under the fingers, and where inside it they landed.
    let focalIndex: Int
    let focalFraction: CGPoint
    /// That point in grid coordinates at the start — the point the overlay
    /// keeps under the fingers.
    let focalPoint: CGPoint
    /// Indices the overlay draws.
    let slice: Range<Int>
    var interpolation: LibraryGridZoom.Interpolation
    var nearestColumns: Int
    var lastMagnification: CGFloat
    var isSettling: Bool
    /// How far the scroll view can still move toward its top and bottom.
    var scrollRoom: ScrollRoom

    /// Where the focal point sits in the blended layout.
    func focalPoint(at interpolation: LibraryGridZoom.Interpolation) -> CGPoint {
        LibraryGridZoom.point(
            in: geometry.interpolatedRect(
                index: focalIndex, from: interpolation.from, to: interpolation.to,
                progress: interpolation.progress),
            fraction: focalFraction)
    }

    /// How far down the overlay is slid so the focal photo stays put,
    /// clamped to what a real scroll could later absorb.
    func overlayShift(at interpolation: LibraryGridZoom.Interpolation) -> CGFloat {
        let wanted = focalPoint.y - focalPoint(at: interpolation).y
        return min(scrollRoom.up, max(-scrollRoom.down, wanted))
    }
}

/// Distance the scroll view can still travel toward each end, in points.
private struct ScrollRoom {
    let up: CGFloat
    let down: CGFloat
}

// MARK: - ScrollGeometryBox

/// Scroll geometry written every frame, read only when a pinch begins or
/// settles. A class so those writes never invalidate the grid's body.
private final class ScrollGeometryBox {
    var gridFrame: CGRect = .zero
    var geometry = ScrollGeometry(
        contentOffset: .zero, contentSize: .zero, contentInsets: EdgeInsets(), containerSize: .zero)

    /// Room left toward the top (the offset can drop this far) and the
    /// bottom (rise this far) — the two amounts a pinch's compensation can
    /// be. `contentOffset` counts from the inset content origin, so the
    /// resting top is `-top inset`. The bottom is measured against the
    /// content height the grid will have at the pinch's TARGET tier (the
    /// live content is still laid out at the base tier): a pinch out lower
    /// in a dense grid needs room the sparser tier brings with it.
    func room(geometry grid: LibraryGridZoom.Geometry, baseColumns: Int, targetColumns: Int) -> ScrollRoom {
        let g = geometry
        let minOffset = -g.contentInsets.top
        let targetContentHeight = g.contentSize.height + grid.heightDelta(from: baseColumns, to: targetColumns)
        let maxOffset = max(minOffset, targetContentHeight + g.contentInsets.bottom - g.containerSize.height)
        return ScrollRoom(
            up: max(0, g.contentOffset.y - minOffset),
            down: max(0, maxOffset - g.contentOffset.y)
        )
    }
}

// MARK: - InterpolatedGridLayout

/// Lays a run of cells (`firstIndex...`) out with each frame blended
/// between two column tiers. `progress` is animatable, so a spring on it
/// re-flows every cell along the straight line between its two homes —
/// the same motion `UICollectionViewTransitionLayout` gives Photos.
private struct InterpolatedGridLayout: Layout {
    let geometry: LibraryGridZoom.Geometry
    let from: Int
    let to: Int
    var progress: CGFloat
    let firstIndex: Int

    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (offset, subview) in subviews.enumerated() {
            let rect = geometry.interpolatedRect(index: firstIndex + offset, from: from, to: to, progress: progress)
            subview.place(
                at: CGPoint(x: bounds.minX + rect.minX, y: bounds.minY + rect.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: rect.width, height: rect.height)
            )
        }
    }
}

#endif
