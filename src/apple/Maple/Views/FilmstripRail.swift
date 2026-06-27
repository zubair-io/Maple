// FilmstripRail.swift — Pro Editor Canvas-first (A2, #1555).
//
// Floating glass filmstrip rail on the leading edge of the canvas-first
// editor (regular size class only).  A content-height glass panel — header
// ("FILMSTRIP" + collapse chevron) over a vertical scroll of landscape
// thumbnails — that the editor centers vertically (it does NOT span the
// full height; the panel caps its thumb-scroll area so few photos render a
// short, centered rail).  Mirrors the web `editor-filmstrip` 110px rail
// (vertically centered, `max-h` cap, collapse toggle).
//
// Thumbnail-loading path matches the horizontal `FilmstripView`: lazy load
// on appear, cancel the in-flight Task on disappear, memoise by asset id.

import SwiftUI
import MapleCore

struct FilmstripRail: View {
    let assets: [AssetRef]
    let activeID: AssetRef.ID?
    /// Source the assets came from — forwarded to `ThumbnailLoader` so the
    /// sourceless thumb path (cloud / PhotoKit / self-hosted) can resolve.
    var source: (any ImageSource)? = nil
    let onSelect: (AssetRef) -> Void

    @State private var collapsed = false

    private let railWidth: CGFloat = 110
    private let thumbSpacing: CGFloat = 6
    /// Max height of the thumb-scroll area; beyond this the strip scrolls.
    private let scrollCap: CGFloat = 460

    private var thumbWidth: CGFloat { railWidth - 16 }
    private var thumbHeight: CGFloat { (thumbWidth * 2 / 3).rounded() } // 3:2 landscape
    private var contentHeight: CGFloat {
        // n thumbnails have only (n-1) inter-thumb gaps — the last carries no
        // trailing spacing, so the rail hugs the thumbs exactly when few.
        let n = CGFloat(assets.count)
        return n > 0 ? n * thumbHeight + (n - 1) * thumbSpacing : 0
    }

    var body: some View {
        VStack(spacing: 8) {
            header
            if !collapsed {
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(spacing: thumbSpacing) {
                        ForEach(assets, id: \.id) { asset in
                            FilmstripRailCell(
                                asset: asset,
                                isActive: asset.id == activeID,
                                width: thumbWidth,
                                height: thumbHeight,
                                source: source,
                                onSelect: onSelect
                            )
                        }
                    }
                    .padding(.bottom, 2)
                }
                // Content-height up to the cap: the scroll area hugs the
                // thumbnails when there are few, scrolls when there are many.
                .frame(height: min(contentHeight, scrollCap))
            }
        }
        .padding(8)
        .frame(width: railWidth)
        .background(
            ProTokens.bg.opacity(ProGlass.opacity),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .accessibilityIdentifier("editor-filmstrip-rail")
    }

    private var header: some View {
        HStack(spacing: 4) {
            Text("FILMSTRIP")
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(ProTokens.textMuted)
            Spacer(minLength: 0)
            Button {
                withAnimation(.easeInOut(duration: 0.2)) { collapsed.toggle() }
            } label: {
                Image(systemName: "chevron.up")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ProTokens.textMuted)
                    .rotationEffect(.degrees(collapsed ? 180 : 0))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(collapsed ? "Expand filmstrip" : "Collapse filmstrip")
            .accessibilityIdentifier("editor-filmstrip-collapse")
        }
        .padding(.horizontal, 2)
    }
}

// MARK: - FilmstripRailCell

private struct FilmstripRailCell: View {
    let asset: AssetRef
    let isActive: Bool
    let width: CGFloat
    let height: CGFloat
    let source: (any ImageSource)?
    let onSelect: (AssetRef) -> Void

    @State private var thumbData: Data?
    @State private var loadTask: Task<Void, Never>?
    @State private var loadedForID: AssetRef.ID?

    var body: some View {
        Button {
            onSelect(asset)
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 5)
                    .fill(ProTokens.panel)

                if let data = thumbData, let cg = ThumbnailImage.cgImage(from: data) {
                    #if os(macOS)
                    Image(nsImage: NSImage(cgImage: cg, size: .zero))
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                    #else
                    Image(uiImage: UIImage(cgImage: cg))
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                    #endif
                }

                if isActive {
                    RoundedRectangle(cornerRadius: 5)
                        .strokeBorder(ProTokens.accent, lineWidth: 2)
                }
            }
            .frame(width: width, height: height)
            .clipShape(RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(asset.displayName)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .onAppear { startLoad() }
        .onDisappear {
            loadTask?.cancel()
            loadTask = nil
        }
    }

    private func startLoad() {
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
}
