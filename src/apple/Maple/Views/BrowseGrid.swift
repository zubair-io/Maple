// BrowseGrid.swift — Lazy thumbnail grid for the Browse column.
//
// Mac/iPad: column in NavigationSplitView. iPhone: main view in TabView.
// Supports selection, keyboard culling (stars 1-5, P/X flags, arrow nav).

import SwiftUI
import MapleCore
import Photos
import ImageIO
import CoreGraphics
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

// MARK: - GridDisplayMode

/// How image cells display their thumbnails inside the square cell box.
/// Folder cells ignore this — they always render as the icon-style tile.
///
/// - `.fill`: image scales to FILL the square, cropping any overflow on the
///   long edge. Default. Reads as a tightly-packed cover-style grid.
/// - `.fit`: image scales to FIT inside the square, leaving letterbox /
///   pillarbox bars on the short edge. Full content visible.
enum GridDisplayMode {
    case fill
    case fit

    /// SwiftUI `ContentMode` for the image inside the square frame.
    var contentMode: ContentMode {
        switch self {
        case .fill: return .fill
        case .fit:  return .fit
        }
    }

    /// Toggle helper.
    var toggled: GridDisplayMode {
        switch self {
        case .fill: return .fit
        case .fit:  return .fill
        }
    }

    /// SF Symbol shown on the toolbar button. Convention: show the OPPOSITE
    /// icon as the action target (i.e. while in fill we offer "switch to fit").
    var toggleIconName: String {
        switch self {
        case .fill: return "rectangle.compress.vertical"  // → fit (shrink content)
        case .fit:  return "rectangle.expand.vertical"    // → fill (cover cell)
        }
    }

    /// Accessibility label for the toolbar button.
    var toggleAccessibilityLabel: String {
        switch self {
        case .fill: return "Fit images to cell"
        case .fit:  return "Fill cells with images"
        }
    }
}

// MARK: - BrowseGrid View

struct BrowseGrid: View {
    /// Injected from `AppShell`. `BrowseViewModel` is `@Observable`, so we
    /// receive the instance directly — no `@ObservedObject` wrapper.
    let vm: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]
    /// How image cells render their thumbnails. Owned by the parent shell so
    /// the toolbar toggle survives BrowseGrid view re-creation. Defaults to
    /// `.fill` when the parent doesn't pass a binding.
    var displayMode: Binding<GridDisplayMode>? = nil
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

    /// Local fallback when no parent binding is supplied (e.g. previews).
    /// Real toolbar wiring lives on `AppShell`.
    @State private var localDisplayMode: GridDisplayMode = .fill

    /// Resolved mode — parent binding wins; otherwise the local @State.
    private var resolvedDisplayMode: GridDisplayMode {
        displayMode?.wrappedValue ?? localDisplayMode
    }

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
                        if vm.isMerged {
                            // Merged Photos + Cloud timeline mode.
                            ForEach(vm.mergedCells, id: \.self) { cell in
                                MergedCellView(cell: cell,
                                               displayMode: resolvedDisplayMode)
                            }
                        } else {
                            // Sub-folders first — Finder-style — then images.
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
                            ForEach(vm.assets) { asset in
                                ThumbnailCell(asset: asset,
                                              isSelected: vm.selectedID == asset.id,
                                              session: sessions[asset.id],
                                              source: vm.currentSource,
                                              displayMode: resolvedDisplayMode)
                                    .id(asset.id)
                                    // Lazy session prime — fires when SwiftUI
                                    // instantiates this cell (i.e. when it
                                    // scrolls into view in the LazyVGrid).
                                    // Replaces the previous eager
                                    // `primeSessionsForCurrentAssets()` which
                                    // built a session per asset in the folder
                                    // regardless of visibility.
                                    .onAppear { onPrimeSession?(asset) }
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
                    }
                    // UITest sentinel — the harness uses
                    // `app.otherElements["browse-grid"]` to confirm browse
                    // mode is active before driving thumbnail selection.
                    .accessibilityIdentifier("browse-grid")
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
                    .font(MapleTokens.Typography.caption)
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
                .font(MapleTokens.Typography.emptyPrimary)
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
                    .font(MapleTokens.Typography.emptySecondary)
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
                .font(MapleTokens.Typography.emptySecondary)
                .foregroundStyle(MapleTokens.textMuted)
                .multilineTextAlignment(.center)
        } else {
            Text("Pick a folder or Photos Library filter in the sidebar.")
                .font(MapleTokens.Typography.emptySecondary)
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
    /// Cell layout — fill (cropped to square) vs fit (letterboxed inside
    /// the square). Cell shape is always 1:1; only the image's content
    /// mode changes.
    let displayMode: GridDisplayMode

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
                // `thumbnailImage` already enforces 1:1 aspect ratio and
                // clips to the rounded rectangle — see its docs for why.
                thumbnailImage

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

        }
        // UITest harness selector. `app.otherElements["thumb-test_0017"]`
        // resolves the cell containing the asset whose displayName is
        // `test_0017`. See docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md.
        .accessibilityIdentifier("thumb-\(asset.displayName)")
        .onAppear { startLoad() }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
        }
    }

    // MARK: - Image

    @ViewBuilder
    private var thumbnailImage: some View {
        ThumbnailImage(jpegData: thumbData, displayMode: displayMode)
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
    // CG decode hoisted into ThumbnailImage.cgImage so the cloud Timeline
    // can share the helper without dragging it in via a private extension.
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

// MARK: - MergedCellView

/// Grid cell for the merged PhotoKit + Cloud timeline. Renders a thumbnail with
/// a small status badge indicating whether the asset is local-only, cloud-only,
/// or synced (present in both places). Thumbnail preference: PhotoKit for
/// `.synced` and `.localOnly` (instant, already on device); CloudSource thumb
/// for `.cloudOnly` via `ThumbnailLoader`.
private struct MergedCellView: View {
    let cell: MergedTimelineCell
    let displayMode: GridDisplayMode

    @State private var thumbData: Data?
    @State private var loadTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 4) {
            ZStack(alignment: .bottomTrailing) {
                ThumbnailImage(jpegData: thumbData, displayMode: displayMode)

                // Status badge
                badgeView
                    .padding(4)
            }

        }
        .onAppear { startLoad() }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
        }
    }

    @ViewBuilder
    private var badgeView: some View {
        switch cell {
        case .synced:
            Image(systemName: "checkmark.icloud.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .shadow(radius: 1)
        case .cloudOnly:
            Image(systemName: "icloud.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .shadow(radius: 1)
        case .localOnly:
            Image(systemName: "icloud.and.arrow.up")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .shadow(radius: 1)
        }
    }

    private var displayName: String {
        switch cell {
        case .localOnly(let r), .cloudOnly(let r): return r.displayName
        case .synced(let l, _): return l.displayName
        }
    }

    /// For `.synced` and `.localOnly`, fetch via PHImageManager (fast, cached
    /// by Photos). For `.cloudOnly`, defer to `ThumbnailLoader` (CloudSource
    /// thumb path).
    private func startLoad() {
        guard loadTask == nil else { return }
        switch cell {
        case .synced(let local, _), .localOnly(let local):
            let phid = local.id
            loadTask = Task { @MainActor in
                let asset = PHAsset.fetchAssets(withLocalIdentifiers: [phid], options: nil).firstObject
                guard let asset else { return }
                let options = PHImageRequestOptions()
                options.deliveryMode = .opportunistic
                options.resizeMode = .fast
                options.isNetworkAccessAllowed = true
                options.isSynchronous = false
                let target = ThumbnailDiskCache.defaultThumbSize
                final class Latch: @unchecked Sendable {
                    let lock = NSLock(); var fired = false
                    func tryFire() -> Bool { lock.lock(); defer { lock.unlock() }; if fired { return false }; fired = true; return true }
                }
                let latch = Latch()
                let img: PlatformImage? = await withCheckedContinuation { cont in
                    PHImageManager.default().requestImage(for: asset, targetSize: target,
                                                          contentMode: .aspectFill,
                                                          options: options) { image, info in
                        if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                        guard latch.tryFire() else { return }
                        cont.resume(returning: image)
                    }
                }
                guard !Task.isCancelled, let image = img else { return }
                if let data = jpegBytes(from: image) {
                    withAnimation(.easeInOut(duration: 0.18)) { thumbData = data }
                }
                loadTask = nil
            }
        case .cloudOnly(let ref):
            loadTask = Task { @MainActor in
                let data = await ThumbnailLoader.shared.load(for: AssetRef(
                    displayName: ref.displayName,
                    hintExtension: (ref.displayName as NSString).pathExtension.lowercased(),
                    stableID: ref.id,
                    bytesProvider: { throw ImageSourceError.unsupported("cloud-only preview") }
                ), from: nil)
                guard !Task.isCancelled, let data else { return }
                withAnimation(.easeInOut(duration: 0.18)) { thumbData = data }
                loadTask = nil
            }
        }
    }

    private func jpegBytes(from image: PlatformImage) -> Data? {
        #if canImport(UIKit)
        let cg = image.cgImage
        #elseif canImport(AppKit)
        var rect = CGRect(origin: .zero, size: image.size)
        let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
        #endif
        guard let cg else { return nil }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.82]
        CGImageDestinationAddImage(dest, cg, opts as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }
}

// MARK: - ThumbnailImage

/// Shared square thumbnail cell. Renders JPEG bytes (or a placeholder
/// when nil) inside a 1:1 rounded rectangle, with the caller's chosen
/// fill/fit content mode. Used by the local Browse grid AND the cloud
/// Timeline grid so both honor the toolbar's fill/fit toggle and pick
/// up future polish (transitions, hover effects, etc.) for free.
///
/// Layout pattern: `Rectangle().overlay { Image }` not `ZStack { ... }`.
/// With a plain ZStack the bounds expand to fit the largest child, and
/// an `Image().resizable().aspectRatio(.fill)` reports a preferred size
/// LARGER than the proposed size (short edge fills, long edge overflows).
/// The ZStack would grow to that overflowing size and an inner `.clipped()`
/// would clip at the wrong frame. Anchoring to the Rectangle and putting
/// the Image in `.overlay` keeps layout anchored to the Rectangle's bounds;
/// the outer `.aspectRatio(1, .fit)` then forces it square at the cell's
/// offered width, and `.clipShape` cleans up the overflow with rounded
/// corners.
struct ThumbnailImage: View {
    let jpegData: Data?
    let displayMode: GridDisplayMode

    var body: some View {
        Rectangle()
            .fill(MapleTokens.surfaceAlt)
            .overlay {
                if let data = jpegData, let cgImg = Self.cgImage(from: data) {
                    #if os(macOS)
                    Image(nsImage: NSImage(cgImage: cgImg, size: .zero))
                        .resizable()
                        .aspectRatio(contentMode: displayMode.contentMode)
                        .transition(.opacity)
                    #else
                    Image(uiImage: UIImage(cgImage: cgImg))
                        .resizable()
                        .aspectRatio(contentMode: displayMode.contentMode)
                        .transition(.opacity)
                    #endif
                } else {
                    Image(systemName: "photo")
                        .foregroundStyle(MapleTokens.textMuted)
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    /// Decode JPEG bytes to a CGImage. Same helper ThumbnailCell used —
    /// hoisted here so both call sites share it.
    static func cgImage(from data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            return nil
        }
        return img
    }
}
