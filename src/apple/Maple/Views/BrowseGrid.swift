// BrowseGrid.swift — Lazy thumbnail grid for the Browse column.
//
// Mac/iPad: column in NavigationSplitView. iPhone: main view in TabView.
// Supports selection, keyboard culling (stars 1-5, P/X flags, arrow nav).

import SwiftUI
import MapleCore
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

// MARK: - BrowseGrid View

struct BrowseGrid: View {
    /// Injected from `AppShell`. `BrowseViewModel` is `@Observable`, so we
    /// receive the instance directly — no `@ObservedObject` wrapper.
    let vm: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]
    /// Fired by the empty state's "Grant Access" button when
    /// `vm.photosAuthNeeded` is true. `nil` in previews / non-Photos flows.
    var onGrantPhotosAccess: (() -> Void)? = nil
    /// Single-click on a sub-folder cell. Shell navigates the explorer into
    /// that folder (claims security scope + reloads the grid).
    var onNavigateFolder: ((URL) -> Void)? = nil
    /// Double-click on an image cell. Shell switches into Full-image / Edit
    /// mode with that asset as the active session.
    var onOpenEditor: ((AssetRef) -> Void)? = nil

    private let columns = [GridItem(.adaptive(minimum: 140, maximum: 200), spacing: 4)]

    /// True when the current folder has neither sub-folders nor images. The
    /// empty-state overlay only takes over in that case — otherwise we're
    /// browsing a populated folder.
    private var isEmpty: Bool {
        vm.assets.isEmpty && vm.subfolders.isEmpty
    }

    var body: some View {
        ZStack(alignment: .top) {
            // The grid itself — always in the hierarchy so SwiftUI doesn't
            // tear it down when assets briefly go empty during a source
            // switch. We fade it under the empty-state only when nothing is
            // loaded at all.
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 4) {
                        // Sub-folders first — Finder-style — then images.
                        ForEach(vm.subfolders, id: \.self) { url in
                            FolderCell(url: url)
                                .onTapGesture {
                                    onNavigateFolder?(url)
                                }
                        }
                        ForEach(vm.assets) { asset in
                            ThumbnailCell(asset: asset,
                                          isSelected: vm.selectedID == asset.id,
                                          session: sessions[asset.id],
                                          source: vm.currentSource)
                                .id(asset.id)
                                // Single click selects (highlights cell, Info
                                // pane refreshes).
                                .onTapGesture {
                                    vm.selectedID = asset.id
                                }
                                // Double click opens the editor.
                                .onTapGesture(count: 2) {
                                    vm.selectedID = asset.id
                                    onOpenEditor?(asset)
                                }
                        }
                    }
                    .padding(8)
                }
                .background(MapleTokens.bg)
                .opacity(isEmpty ? 0 : 1)
                .onChange(of: vm.selectedID) { _, newID in
                    if let id = newID { proxy.scrollTo(id, anchor: .center) }
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
        .keyboardShortcuts(vm: vm, sessions: sessions)
    }
}

// MARK: - FolderCell

/// Grid cell rendering a sub-folder. Single click navigates into it via the
/// `onNavigateFolder` callback on `BrowseGrid`.
private struct FolderCell: View {
    let url: URL

    var body: some View {
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
                .font(.system(size: 10))
                .foregroundStyle(MapleTokens.textMain)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .accessibilityLabel("Folder \(url.lastPathComponent)")
        .accessibilityAddTraits(.isButton)
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
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(MapleTokens.textMain)

            secondary
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var iconName: String {
        vm.photosAuthNeeded ? "lock.shield" : "photo.on.rectangle.angled"
    }

    private var primaryTitle: String {
        vm.photosAuthNeeded ? "Photos access not granted" : "No assets yet"
    }

    @ViewBuilder
    private var secondary: some View {
        if vm.photosAuthNeeded {
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
        } else if vm.isLoading {
            HStack(spacing: 8) {
                ProgressView()
                    .scaleEffect(0.8)
                Text("Loading…")
                    .font(.system(size: 11))
                    .foregroundStyle(MapleTokens.textMuted)
            }
        } else if let err = vm.loadError {
            VStack(spacing: 6) {
                Text(err.localizedDescription)
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
        } else if vm.currentSource != nil {
            Text("This folder has no supported RAW files.")
                .font(.system(size: 11))
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
        } else {
            Text("Pick a folder or Photos Library filter in the sidebar.")
                .font(.system(size: 11))
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

// MARK: - ThumbnailCell

struct ThumbnailCell: View {
    let asset: AssetRef
    let isSelected: Bool
    let session: EditSession?
    /// The source the asset came from. Used by sourceless assets (PhotoKit,
    /// SelfHosted) to call `ImageSource.thumb(for:)` before falling back to a
    /// full RAW render. `nil` for the URL-keyed filesystem path.
    let source: (any ImageSource)?

    /// JPEG bytes from `ThumbnailLoader`. `nil` while the cell is loading or
    /// the render failed; in both cases we keep the placeholder visible.
    @State private var thumbData: Data?
    /// In-flight load task — cancelled on `.onDisappear` so scrolling past a
    /// 1000-image folder doesn't queue up 1000 decodes.
    @State private var loadTask: Task<Void, Never>?
    /// Memoise the asset id we last loaded for, so cells reused via SwiftUI's
    /// recycle pool don't re-render the same thumb when they re-appear.
    @State private var loadedForID: AssetRef.ID?

    var body: some View {
        VStack(spacing: 4) {
            ZStack(alignment: .bottomLeading) {
                thumbnailImage
                    .aspectRatio(3/2, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 4))

                // Culling badges
                if let session {
                    HStack(spacing: 2) {
                        FlagBadge(flag: session.culling.flag)
                        if session.culling.stars > 0 {
                            StarView(count: session.culling.stars)
                        }
                    }
                    .padding(4)
                }
            }
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(MapleTokens.primary, lineWidth: 2)
                }
            }

            Text(asset.displayName)
                .font(.system(size: 10))
                .foregroundStyle(MapleTokens.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .onAppear { startLoad() }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
        }
    }

    // MARK: - Image

    @ViewBuilder
    private var thumbnailImage: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .fill(MapleTokens.surfaceAlt)
                .overlay {
                    Image(systemName: "photo")
                        .foregroundStyle(MapleTokens.textMuted)
                }
            if let data = thumbData, let cgImg = Self.cgImage(from: data) {
                #if os(macOS)
                Image(nsImage: NSImage(cgImage: cgImg, size: .zero))
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
                #else
                Image(uiImage: UIImage(cgImage: cgImg))
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
                #endif
            }
        }
    }

    // MARK: - Loading

    private func startLoad() {
        // Memoised: if we've already produced bytes for this exact asset id,
        // don't re-queue when the cell scrolls back into view.
        if loadedForID == asset.id, thumbData != nil { return }
        guard loadTask == nil else { return }
        let capturedAsset = asset
        let capturedSource = source
        loadTask = Task { @MainActor in
            let data = await ThumbnailLoader.shared.load(
                for: capturedAsset, from: capturedSource
            )
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.18)) {
                thumbData = data
                loadedForID = capturedAsset.id
            }
            loadTask = nil
        }
    }

    // MARK: - Data → CGImage

    /// Build a CGImage from JPEG bytes. Re-reads on every body evaluation —
    /// the caller (`thumbnailImage`) is inside a View, so this is cheap in
    /// practice (CoreGraphics caches decoded frames), but if profiling shows
    /// pressure we should hoist the decode into the loader.
    private static func cgImage(from data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(src, 0, nil)
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
