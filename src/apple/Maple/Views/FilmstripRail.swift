// FilmstripRail.swift — Pro Editor Canvas-first (A2, #1555).
//
// Vertical filmstrip rail shown on the leading edge of the canvas-first
// editor (regular size class only).  Mirrors the data + thumbnail-loading
// path of the horizontal `FilmstripView` (lazy load on appear, cancel the
// in-flight Task on disappear, memoise by asset id) but reoriented to a
// vertical glass column with a 2pt accent ring on the active asset.

import SwiftUI
import MapleCore

struct FilmstripRail: View {
    let assets: [AssetRef]
    let activeID: AssetRef.ID?
    /// Source the assets came from — forwarded to `ThumbnailLoader` so the
    /// sourceless thumb path (cloud / PhotoKit / self-hosted) can resolve.
    var source: (any ImageSource)? = nil
    let onSelect: (AssetRef) -> Void

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(spacing: 4) {
                ForEach(assets, id: \.id) { asset in
                    FilmstripRailCell(
                        asset: asset,
                        isActive: asset.id == activeID,
                        source: source,
                        onSelect: onSelect
                    )
                }
            }
            .padding(.vertical, 8)
        }
        .frame(width: 56)
        .background(ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityIdentifier("editor-filmstrip-rail")
    }
}

// MARK: - FilmstripRailCell

private struct FilmstripRailCell: View {
    let asset: AssetRef
    let isActive: Bool
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
                RoundedRectangle(cornerRadius: 4)
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
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(ProTokens.accent, lineWidth: 2)
                }
            }
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: 4))
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
