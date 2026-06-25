// BrowseGrid.swift — Lazy thumbnail grid for the Browse column.
//
// Mac/iPad: column in NavigationSplitView. iPhone: main view in TabView.
// Supports selection, keyboard culling (stars 1-5, P/X flags, arrow nav).
//
// M1b (#1490): migrated onto the shared PhotoGrid / PhotoThumbnailCell /
// ThumbnailProvider. The inline LazyVGrid / ForEach body + MergedCellView
// are replaced; FolderCell / FolderCellButtonStyle / BrowseEmptyState /
// ErrorBanner / keyboard shortcuts are kept unchanged.

import SwiftUI
import MapleCore

// MARK: - GridDisplayMode
// Moved to Maple/Views/Grid/ThumbnailImage.swift (#1490 M0).

// MARK: - BrowseGrid View

struct BrowseGrid: View {
    /// Injected from `AppShell`. `BrowseViewModel` is `@Observable`, so we
    /// receive the instance directly — no observed-object wrapper needed.
    let vm: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]
    /// How image cells render their thumbnails. Owned by the parent shell so
    /// the toolbar toggle survives BrowseGrid view re-creation. Defaults to
    /// `.fill` when the parent doesn't pass a binding.
    var displayMode: Binding<GridDisplayMode>? = nil
    /// Grid zoom level — drives ColumnStrategy.zoom (#1550). Optional so
    /// previews can omit it; defaults to .comfortable when nil.
    var zoomLevel: Binding<GridZoomLevel>? = nil
    /// Fired by the empty state's "Grant Access" button when
    /// `vm.photosAuthNeeded` is true. `nil` in previews / non-Photos flows.
    var onGrantPhotosAccess: (() -> Void)? = nil
    /// Single-click on a sub-folder cell. Shell navigates the explorer into
    /// that folder (claims security scope + reloads the grid).
    var onNavigateFolder: ((URL) -> Void)? = nil
    /// Double-click on an image cell. Shell switches into Full-image / Edit
    /// mode with that asset as the active session.
    var onOpenEditor: ((AssetRef) -> Void)? = nil
    /// Called from each thumbnail cell's `.onAppear`. Used by AppShell to
    /// lazily create per-asset `EditSession`s only when their cell scrolls
    /// into view, instead of eagerly priming every asset in the folder.
    var onPrimeSession: ((AssetRef) -> Void)? = nil
    /// Fired when the user taps "Merge to Panorama…" from the selection bar
    /// (≥2 assets selected). `nil` suppresses the bar entirely (e.g. previews).
    var onMergePanorama: (() -> Void)? = nil
    /// Cloud thumb infrastructure for merged mode. When nil (the default),
    /// cloud-only merged cells fall through to `ThumbnailLoader.shared`
    /// (same behaviour as the old MergedCellView's cloud-only path).
    var thumbClient: CloudThumbClient? = nil
    var thumbCache: CloudThumbCache? = nil
    /// Server cache-host key for merged-mode cloud thumbs. Used by
    /// `ThumbnailProvider` to namespace the disk cache per-server identically
    /// to the cloud timeline. Empty string when no cloud infra is wired.
    var mergedHost: String = ""

    /// Local fallback when no parent binding is supplied (e.g. previews).
    /// Real toolbar wiring lives on `AppShell`.
    @State private var localDisplayMode: GridDisplayMode = .fill
    @State private var localZoomLevel: GridZoomLevel = .comfortable

    /// Resolved mode — parent binding wins; otherwise the local @State.
    private var resolvedDisplayMode: GridDisplayMode {
        displayMode?.wrappedValue ?? localDisplayMode
    }

    /// Resolved zoom level — parent binding wins; otherwise local @State.
    private var resolvedZoomLevel: GridZoomLevel {
        zoomLevel?.wrappedValue ?? localZoomLevel
    }

    /// Binding for the pinch modifier. Writes to parent or local depending
    /// on whether a parent binding was supplied.
    private var zoomLevelBinding: Binding<GridZoomLevel> {
        zoomLevel ?? $localZoomLevel
    }

    /// True when the current folder has neither sub-folders nor images. The
    /// empty-state overlay only takes over in that case — otherwise we're
    /// browsing a populated folder.
    private var isEmpty: Bool {
        vm.assets.isEmpty && vm.subfolders.isEmpty
    }

    /// Thumbnail provider for normal (local) mode.
    @State private var localProvider = ThumbnailProvider.local()

    /// Thumbnail provider for merged mode. Built ONCE in `.task` when cloud infra
    /// is wired (not per body evaluation, per `ThumbnailProvider`'s "inject once
    /// per grid surface" guidance). `nil` until set / when no cloud infra — merged
    /// mode then falls back to `localProvider`.
    @State private var mergedProvider: ThumbnailProvider?

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                // The grid itself — always in the hierarchy so SwiftUI doesn't
                // tear it down when assets briefly go empty during a source
                // switch. We fade it under the empty-state only when nothing is
                // loaded at all.
                ScrollViewReader { proxy in
                    ScrollView {
                        Group {
                            if vm.isMerged {
                                mergedGrid
                            } else {
                                normalGrid
                            }
                        }
                        // UITest sentinel — the harness uses
                        // `app.otherElements["browse-grid"]` to confirm browse
                        // mode is active before driving thumbnail selection.
                        .accessibilityIdentifier("browse-grid")
                        .padding(8)
                        // Bottom padding so the last row isn't hidden under
                        // the selection bar when it's shown.
                        .padding(.bottom, vm.isSelecting ? 60 : 0)
                    }
                    .gridZoomPinch(level: zoomLevelBinding)
                    .background(MapleTokens.bg)
                    .opacity(isEmpty ? 0 : 1)
                    .onChange(of: vm.selectedID) { _, newID in
                        // Minimum scroll — bring the cell into view only when it's
                        // outside the viewport. `.center` re-centered every click,
                        // and the resulting mid-click layout shift made rapid taps
                        // land on the wrong cell. Keyboard arrow nav still works:
                        // when the next/prev cell is offscreen, SwiftUI scrolls just
                        // enough to expose it.
                        if let id = newID { proxy.scrollTo(id, anchor: nil) }
                    }
                }

                // Error banner at the top of the grid.
                if let err = vm.loadError {
                    ErrorBanner(
                        message: err.localizedDescription,
                        onRetry: { vm.loadError = nil },
                        onDismiss: { vm.loadError = nil }
                    )
                    .padding(8)
                }

                // Empty state overlay — only when the folder has zero folders AND
                // zero images.
                if isEmpty {
                    BrowseEmptyState(vm: vm, onGrantPhotosAccess: onGrantPhotosAccess)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(MapleTokens.bg)
                }
            }

            // Multi-select action bar — shown only when in select mode and an
            // onMergePanorama handler was wired (prevents showing in previews).
            if vm.isSelecting, let onMergePanorama {
                PanoSelectionBar(vm: vm, onMerge: onMergePanorama)
            }
        }
        .keyboardShortcuts(vm: vm, sessions: sessions)
        .task {
            // Build the merged-mode cloud provider ONCE (not per body eval). The
            // host must be set when cloud infra is wired, else CloudThumbCache
            // lookups collide across servers under an empty namespace.
            guard mergedProvider == nil, let client = thumbClient, let cache = thumbCache
            else { return }
            assert(!mergedHost.isEmpty, "BrowseGrid: cloud thumb infra wired without a mergedHost")
            mergedProvider = ThumbnailProvider(thumbClient: client, thumbCache: cache)
        }
    }

    // MARK: - Merged grid (PhotoKit + Cloud timeline)

    /// Renders when `vm.isMerged` is true. No folders, no multi-select.
    /// Each `MergedTimelineCell` maps to a `PhotoGridItem(merged:)` inside
    /// the `LazyVGrid`'s `ForEach` (lazy — only visible cells pay the cost).
    @ViewBuilder
    private var mergedGrid: some View {
        PhotoGrid(
            data: vm.mergedCells,
            columns: .zoom(resolvedZoomLevel),
            provider: mergedProvider ?? localProvider,
            displayMode: resolvedDisplayMode,
            // Tap routing: the original BrowseGrid merged-mode ForEach had no
            // .onTapGesture — merged cells in BrowseGrid are informational only;
            // the full merged-tap routing lives in CloudTimelineView. Kept as
            // no-op to preserve the same behaviour.
            onTap: { _ in },
            makeItem: { cell in
                PhotoGridItem(
                    merged: cell,
                    host: mergedHost,
                    sync: syncBadge(for: cell),
                    style: .desktop
                )
            }
        )
    }

    // MARK: - Normal grid (local assets + subfolders)

    /// Renders when `vm.isMerged` is false. Includes folder cells in the
    /// `leading:` slot, desktop badge overlays, multi-select, and session priming.
    @ViewBuilder
    private var normalGrid: some View {
        PhotoGrid(
            data: vm.assets,
            columns: .zoom(resolvedZoomLevel),
            provider: localProvider,
            displayMode: resolvedDisplayMode,
            selection: vm.isSelecting
                ? vm.selectedIDs
                : (vm.selectedID.map { Set([$0]) } ?? []),
            onAppearItem: { asset in onPrimeSession?(asset) },
            multiSelectChecked: vm.isSelecting ? { asset in
                vm.selectedIDs.contains(asset.id)
            } : nil,
            onTap: { asset in
                if vm.isSelecting {
                    // Multi-select mode: tap toggles check.
                    vm.toggleSelected(asset.id)
                } else {
                    // Normal mode: tap opens the editor.
                    vm.selectedID = asset.id
                    onOpenEditor?(asset)
                }
            },
            makeItem: { asset in
                PhotoGridItem(local: asset, source: vm.currentSource,
                              overlays: desktopOverlays(for: asset))
            },
            leading: {
                // Sub-folders first — Finder-style — then images.
                // Folder cells are hidden during multi-select so
                // only image tiles can be checked.
                if !vm.isSelecting {
                    ForEach(vm.subfolders, id: \.self) { url in
                        // Single tap navigates into the folder. The
                        // FolderCell button style provides press
                        // feedback (scale + tinted background) so the
                        // user gets immediate confirmation the tap
                        // registered before the grid reloads.
                        FolderCell(url: url) {
                            onNavigateFolder?(url)
                        }
                    }
                }
            }
        )
        // ScrollViewReader uses the element's `.id` as the scrollTo anchor.
        // ForEach inside PhotoGrid tags each element by `element.id` (AssetRef.ID),
        // which is the same value `vm.selectedID` holds — so scrollTo works.
    }

    // MARK: - Overlay derivation

    /// Desktop badge overlays for one asset, derived from `sessions[asset.id]`.
    /// Matches the original LibraryCell `.desktop` badge derivation exactly.
    private func desktopOverlays(for asset: AssetRef) -> GridCellOverlays {
        let session = sessions[asset.id]
        let cullFlag = session?.culling.flag ?? .none
        return GridCellOverlays(
            rating: session?.culling.stars ?? 0,
            flag: cullFlag == .none ? nil : cullFlag,
            sync: nil,
            isVideo: false,
            style: .desktop
        )
    }

    // MARK: - Merged cell SyncBadge derivation

    private func syncBadge(for cell: MergedTimelineCell) -> SyncBadge {
        switch cell {
        case .synced:    return .synced
        case .cloudOnly: return .cloudOnly
        case .localOnly: return .localOnly
        }
    }

}

// MARK: - FolderCell

/// Grid cell rendering a sub-folder. Single tap navigates into it; the
/// cell is wrapped in a Button with a custom ButtonStyle so the user
/// gets press feedback (scale + tinted overlay) before the grid reloads.
private struct FolderCell: View {
    let url: URL
    let onNavigate: () -> Void

    var body: some View {
        Button(action: onNavigate) {
            VStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(MapleTokens.surfaceAlt)
                    .aspectRatio(3/2, contentMode: .fit)
                    .overlay {
                        Image(systemName: "folder.fill")
                            .font(.system(size: 36))
                            .foregroundStyle(MapleTokens.primary.opacity(0.85))
                    }
                Text(url.lastPathComponent)
                    .font(MapleTokens.Typography.body)
                    .foregroundStyle(MapleTokens.textMain)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(FolderCellButtonStyle())
        .accessibilityLabel("Folder \(url.lastPathComponent)")
    }
}

/// Press feedback for FolderCell. Scales down slightly and overlays a
/// subtle white tint while the user's finger is down, easing back when
/// released — same idea as iOS list-row highlights, scoped to the cell.
private struct FolderCellButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(configuration.isPressed ? MapleTokens.bgActive : .clear)
                    .padding(-4)
            )
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - BrowseEmptyState

/// Centred illustration + contextual text shown when `vm.assets` is empty.
private struct BrowseEmptyState: View {
    let vm: BrowseViewModel
    let onGrantPhotosAccess: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: iconName)
                .font(.system(size: 48))
                .foregroundStyle(MapleTokens.textMuted)

            Text(primaryTitle)
                .font(MapleTokens.Typography.sheetTitle)
                .foregroundStyle(MapleTokens.textMain)

            secondary
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var iconName: String {
        BrowseGridVM.emptyStateIconName(photosAuthNeeded: vm.photosAuthNeeded)
    }

    private var primaryTitle: String {
        BrowseGridVM.emptyStatePrimaryTitle(photosAuthNeeded: vm.photosAuthNeeded)
    }

    private var secondaryCase: BrowseGridVM.EmptyStateSecondary {
        BrowseGridVM.emptyStateSecondary(.init(
            photosAuthNeeded: vm.photosAuthNeeded,
            isLoading: vm.isLoading,
            hasLoadError: vm.loadError != nil,
            hasCurrentSource: vm.currentSource != nil
        ))
    }

    @ViewBuilder
    private var secondary: some View {
        switch secondaryCase {
        case .photosAuthCTA:
            VStack(spacing: 8) {
                Text("Maple needs permission to read your Photos library.")
                    .font(.system(size: 11))
                    .foregroundStyle(MapleTokens.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                Button("Grant Access") { onGrantPhotosAccess?() }
                    .buttonStyle(.bordered)
                    .disabled(onGrantPhotosAccess == nil)
            }
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading…")
                    .font(MapleTokens.Typography.rowLabel)
                    .foregroundStyle(MapleTokens.textMuted)
            }
        case .loadError:
            VStack(spacing: 6) {
                Text(vm.loadError?.localizedDescription ?? "")
                    .font(.system(size: 11))
                    .foregroundStyle(MapleTokens.textMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                Button("Retry") {
                    // Clear the error — the sidebar row-tap re-runs the load.
                    vm.loadError = nil
                }
                .buttonStyle(.bordered)
            }
        case .sourceHasNoRaws:
            Text("This folder has no supported RAW files.")
                .font(MapleTokens.Typography.rowLabel)
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
        case .noSourcePicked:
            Text("Pick a folder or Photos Library filter in the sidebar.")
                .font(MapleTokens.Typography.rowLabel)
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
        }
    }
}

// MARK: - ErrorBanner

/// Thin red banner that sits at the top of the grid when `vm.loadError`
/// is non-nil. Matches the shape of the web `app-error-banner`.
private struct ErrorBanner: View {
    let message: String
    let onRetry: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(MapleTokens.errorText)
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(MapleTokens.errorText)
                .lineLimit(2)
            Spacer()
            Button("Retry", action: onRetry)
                .font(.system(size: 11))
                .buttonStyle(.plain)
                .foregroundStyle(MapleTokens.primary)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(MapleTokens.textMuted)
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(MapleTokens.errorBg)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(MapleTokens.errorText.opacity(0.4), lineWidth: 0.5)
                )
        )
    }
}

// MARK: - Keyboard shortcuts via ViewModifier

private struct BrowseKeyboardShortcuts: ViewModifier {
    let vm: BrowseViewModel
    let sessions: [AssetRef.ID: EditSession]

    func body(content: Content) -> some View {
        content
            // Arrow navigation
            .onKeyPress(.rightArrow) { vm.selectNext(); return .handled }
            .onKeyPress(.leftArrow)  { vm.selectPrev(); return .handled }
            // Star ratings 1-5
            .onKeyPress("1") { setStars(1); return .handled }
            .onKeyPress("2") { setStars(2); return .handled }
            .onKeyPress("3") { setStars(3); return .handled }
            .onKeyPress("4") { setStars(4); return .handled }
            .onKeyPress("5") { setStars(5); return .handled }
            .onKeyPress("0") { setStars(0); return .handled }
            // Pick / reject
            .onKeyPress("p") { setFlag(.pick);   return .handled }
            .onKeyPress("x") { setFlag(.reject); return .handled }
            .onKeyPress("u") { setFlag(.none);   return .handled }
    }

    private func setStars(_ n: Int) {
        guard let id = vm.selectedID, let session = sessions[id] else { return }
        Task { @MainActor in
            var c = session.culling
            c.stars = n
            session.culling = c
        }
    }

    private func setFlag(_ f: CullFlag) {
        guard let id = vm.selectedID, let session = sessions[id] else { return }
        Task { @MainActor in
            var c = session.culling
            c.flag = f
            session.culling = c
        }
    }
}

private extension View {
    func keyboardShortcuts(vm: BrowseViewModel, sessions: [AssetRef.ID: EditSession]) -> some View {
        modifier(BrowseKeyboardShortcuts(vm: vm, sessions: sessions))
    }
}

// MARK: - Previews
//
// Issue #139 — grid against the `BrowseViewModel.preview(...)` factory.
// Thumbnails fail to load (the preview AssetRef has no bytes), so each
// cell shows the placeholder shimmer; the grid layout itself renders
// correctly. Coverage: empty, loaded, loading, error, photosAuthNeeded.

private struct _BrowseGridPreviewWrapper: View {
    let vm: BrowseViewModel
    let grantPhotos: Bool
    @State private var sessions: [AssetRef.ID: EditSession] = [:]

    init(vm: BrowseViewModel, grantPhotos: Bool = false) {
        self.vm = vm
        self.grantPhotos = grantPhotos
    }

    var body: some View {
        BrowseGrid(
            vm: vm,
            sessions: $sessions,
            onGrantPhotosAccess: grantPhotos ? {} : nil
        )
        .frame(width: 720, height: 540)
    }
}

#Preview("Loaded") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.loaded(count: 18)))
}

#Preview("Empty") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.empty))
}

#Preview("Loading") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.loading))
}

#Preview("Error") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.error))
}

#Preview("Photos access needed") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.photosAuthNeeded),
                              grantPhotos: true)
}
