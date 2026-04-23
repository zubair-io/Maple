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

    private let columns = [GridItem(.adaptive(minimum: 140, maximum: 200), spacing: 4)]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVGrid(columns: columns, spacing: 4) {
                    ForEach(vm.assets) { asset in
                        ThumbnailCell(asset: asset,
                                      isSelected: vm.selectedID == asset.id,
                                      session: sessions[asset.id])
                            .id(asset.id)
                            .onTapGesture { vm.selectedID = asset.id }
                    }
                }
                .padding(8)
            }
            .background(MapleTokens.bg)
            .onChange(of: vm.selectedID) { _, newID in
                if let id = newID { proxy.scrollTo(id, anchor: .center) }
            }
        }
        .keyboardShortcuts(vm: vm, sessions: sessions)
    }
}

// MARK: - ThumbnailCell

struct ThumbnailCell: View {
    let asset: AssetRef
    let isSelected: Bool
    let session: EditSession?

    /// JPEG bytes from `ThumbnailLoader`. `nil` while the cell is loading or
    /// the render failed; in both cases we keep the placeholder visible.
    @State private var thumbData: Data?
    /// In-flight load task — cancelled on `.onDisappear` so scrolling past a
    /// 1000-image folder doesn't queue up 1000 decodes.
    @State private var loadTask: Task<Void, Never>?

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
        guard thumbData == nil, loadTask == nil else { return }
        let url = asset.primaryURL
        loadTask = Task { @MainActor in
            let data = await ThumbnailLoader.shared.load(for: url)
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.18)) {
                thumbData = data
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
