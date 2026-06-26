// LibraryGrid.swift — responsive-program S2 (#623). Responsive photo
// grid for the Library tab.
//
// Drives column count, gap, and outer padding off the
// `@Environment(\.mapleLayout)` density signal published by AppShell.
// ColumnStrategy.zoom resolves per layout:
//   * phone   — exact fixed counts (1/3/5/10) per GridZoomLevel
//   * tablet  — adaptive at desktopCellWidth, reflows columns on resize
//   * desktop — adaptive at desktopCellWidth, reflows columns on resize
//
// Cell tap routes through `onOpenEditor` (same callback BrowseGrid
// uses — the iPhone shell already pushes the Editor via
// `.navigationDestination(for: AssetRef.self)`).
//
// The in-content source title and the cull filter-chip row were removed
// (#782): the source name lives in the nav bar, and the chips duplicated
// cull state that belongs in the editor. The grid now renders
// `vm.assets` unfiltered.
//
// Spec: docs/design/responsive-program/s2-library-grid.md.
//
// M1a (#1490): migrated onto the shared PhotoGrid / PhotoThumbnailCell /
// ThumbnailProvider. The LazyVGrid body is replaced; LibraryFolderCell
// is kept for the `leading:` slot. LibraryCell was deleted in M1b (#1490)
// after BrowseGrid migrated off it.
//
// #1550: ColumnStrategy.zoom replaces .responsiveBySizeClass; pinch modifier added.
// #1550 focal-anchoring: ScrollViewReader added; focal state + gridZoomPinchFocal
// wired so the pinched image stays in its column across level changes.

#if os(iOS)

import SwiftUI
import MapleCore
#if canImport(UIKit)
import UIKit
#endif

/// Surfaces the content width of the library grid to the focal-zoom resolver.
private struct LibraryGridWidthPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct LibraryGrid: View {
    @Environment(\.mapleLayout) private var layout

    let vm: BrowseViewModel
    let source: (any ImageSource)?
    @Binding var sessions: [AssetRef.ID: EditSession]
    @Binding var displayMode: GridDisplayMode
    /// Current zoom level — drives ColumnStrategy.zoom (#1550).
    @Binding var zoomLevel: GridZoomLevel

    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    /// Tap on a sub-folder tile — drills the grid into that folder.
    let onNavigateFolder: (URL) -> Void

    /// Local-only thumbnail provider.
    @State private var provider = ThumbnailProvider.local()

    // MARK: - Focal-anchoring state (#1550)

    /// True while a pinch gesture is active — enables frame publishing in PhotoGrid.
    @State private var isPinching = false
    /// The pinch's UnitPoint anchor, frozen on first onChanged.
    @State private var startAnchor: UnitPoint = .center
    /// Frozen snapshot of visible cell frames, captured on first onChanged.
    /// Read by `resolveFocalZoom` in onEnded; cleared once the settle completes.
    @State private var frozenFrames: [AnyHashable: CGRect] = [:]
    /// How many invisible leading spacer cells to prepend in PhotoGrid.
    @State private var leadingSpacerCount: Int = 0
    /// Measured width of the grid's content area (from GeometryReader / onGeometryChange).
    @State private var contentWidth: CGFloat = 0
    /// Column count inferred from first-row distinct x-origins in frozenFrames (nil = unmeasured).
    @State private var measuredColumnCount: Int? = nil

    /// TEMPORARY (#1550): presents the scale-zoom smoothness prototype. Remove
    /// this + the overlay button + ScaleZoomTest.swift once the approach is decided.
    @State private var showZoomTest = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    PhotoGrid(
                        data: vm.assets,
                        columns: .zoom(zoomLevel),
                        provider: provider,
                        displayMode: displayMode,
                        selection: vm.selectedID.map { Set([$0]) } ?? [],
                        onAppearItem: { asset in onPrimeSession(asset) },
                        leadingSpacerCount: leadingSpacerCount,
                        publishFrames: isPinching,
                        onTap: { asset in
                            vm.selectedID = asset.id
                            #if canImport(UIKit)
                            UISelectionFeedbackGenerator().selectionChanged()
                            #endif
                            onOpenEditor(asset)
                        },
                        makeItem: { asset in
                            PhotoGridItem(local: asset, source: source, overlays: overlays(for: asset))
                        },
                        leading: {
                            ForEach(Array(vm.subfolders.reversed()), id: \.self) { url in
                                LibraryFolderCell(url: url) { onNavigateFolder(url) }
                            }
                        }
                    )
                    .padding(.horizontal, outerHorizontalPadding)
                    .accessibilityIdentifier("library-grid")
                    // Measure content width for the adaptive column-count formula.
                    // GeometryReader background is compatible with the iOS 17 deployment target.
                    .background(
                        GeometryReader { geo in
                            Color.clear.preference(
                                key: LibraryGridWidthPreferenceKey.self,
                                value: geo.size.width
                            )
                        }
                    )
                }
            }
            .onPreferenceChange(LibraryGridWidthPreferenceKey.self) { width in
                contentWidth = width
            }
            // Coordinate space for cell-frame publishing.
            .coordinateSpace(.named("gridViewport"))
            // Collect cell frames into frozenFrames while pinching.
            // Freeze on first delivery (isPinching flips true on first onChanged);
            // subsequent deliveries during the pinch are ignored (landmine #2).
            .onPreferenceChange(CellFramePreferenceKey.self) { frames in
                guard isPinching, frozenFrames.isEmpty else { return }
                frozenFrames = frames
                // Measure the column count from distinct first-row x-origins.
                measuredColumnCount = distinctFirstRowColumns(in: frames)
            }
            .gridZoomPinchFocal(
                level: $zoomLevel,
                isPinching: $isPinching,
                startAnchor: $startAnchor
            ) { anchor, snappedLevel in
                applyFocalZoom(proxy: proxy, anchor: anchor, snappedLevel: snappedLevel)
            }
            .background(MapleTokens.bg)
            // TEMPORARY (#1550): scale-zoom prototype entry — remove with ScaleZoomTest.swift.
            .overlay(alignment: .bottomTrailing) {
                Button {
                    showZoomTest = true
                } label: {
                    Text("🧪")
                        .font(.system(size: 22))
                        .padding(10)
                        .background(Circle().fill(.black.opacity(0.55)))
                }
                .padding(16)
                .accessibilityIdentifier("scale-zoom-test-button")
            }
            .fullScreenCover(isPresented: $showZoomTest) {
                ScaleZoomTest(assets: vm.assets, source: source, provider: provider) {
                    showZoomTest = false
                }
            }
        }
    }

    // MARK: - Focal zoom application

    private func applyFocalZoom(proxy: ScrollViewProxy, anchor: UnitPoint, snappedLevel: GridZoomLevel) {
        let orderedIDs = vm.assets.map { $0.id }
        let folderCount = vm.subfolders.count

        let (focalID, spacers, focalYUnit) = resolveFocalZoom(
            startAnchor: anchor,
            frozenFrames: frozenFrames,
            viewportSize: viewportSize(),
            orderedIDs: orderedIDs,
            leadingFolderCount: folderCount,
            selectedID: vm.selectedID,
            oldLevel: zoomLevel,
            newLevel: snappedLevel,
            contentWidth: contentWidth,
            layout: layout,
            measuredColumnCount: measuredColumnCount
        )

        // Apply the level + spacer count atomically inside the animation.
        withAnimation(.smooth(duration: 0.30)) {
            zoomLevel = snappedLevel
            leadingSpacerCount = spacers
        }

        // Yield to the run loop so the lazy grid registers new dimensions
        // before scrollTo (landmine #3 — scroll before layout = wrong offset).
        if let id = focalID {
            let anchor = UnitPoint(x: 0.5, y: focalYUnit)
            Task { @MainActor in
                proxy.scrollTo(id, anchor: anchor)
            }
        }

        // Clear frame snapshot after the settle window.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.40) {
            frozenFrames = [:]
            measuredColumnCount = nil
        }
    }

    // MARK: - Helpers

    /// Approximate the viewport size from the content width + device screen height.
    /// Used for the hit-test in resolveFocalZoom. The ScrollView itself provides
    /// the viewport height indirectly via UIScreen; on iPad/Mac a GeometryReader
    /// on the scroll view would be more precise but this is a non-critical fallback.
    private func viewportSize() -> CGSize {
        #if canImport(UIKit)
        let screenHeight = UIScreen.main.bounds.height
        #else
        let screenHeight: CGFloat = 800
        #endif
        return CGSize(width: contentWidth, height: screenHeight)
    }

    /// Count distinct first-row x-origins to determine how many columns
    /// SwiftUI actually packed (ground truth, avoids off-by-one vs formula).
    private func distinctFirstRowColumns(in frames: [AnyHashable: CGRect]) -> Int? {
        guard !frames.isEmpty else { return nil }
        // Find the minimum midY among all frames (top row).
        let minY = frames.values.min { $0.midY < $1.midY }?.midY ?? 0
        // Collect frames whose midY is within one cell-height of the top row.
        let topRowFrames = frames.values.filter { abs($0.midY - minY) < $0.height }
        // Distinct x-origins (rounded to 2pt to absorb floating-point noise).
        let distinctX = Set(topRowFrames.map { ($0.minX * 0.5).rounded() })
        return distinctX.isEmpty ? nil : distinctX.count
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
            style: .phone
        )
    }

    // MARK: - Layout

    private var outerHorizontalPadding: CGFloat {
        switch layout {
        case .phone:   return 2
        case .tablet:  return 8
        case .desktop: return 12
        }
    }
}

// MARK: - LibraryFolderCell

/// Square sub-folder tile for the phone Library grid.
private struct LibraryFolderCell: View {
    let url: URL
    let onNavigate: () -> Void

    var body: some View {
        Button(action: onNavigate) {
            RoundedRectangle(cornerRadius: 2)
                .fill(MapleTokens.surfaceAlt)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    Image(systemName: "folder.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(MapleTokens.primary.opacity(0.85))
                }
                .overlay(alignment: .bottomLeading) {
                    Text(url.lastPathComponent)
                        .font(MapleTokens.Typography.body)
                        .foregroundStyle(MapleTokens.textMain)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(6)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Folder \(url.lastPathComponent)")
    }
}

#endif
