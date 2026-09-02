// AsyncThumbnail.swift — shared thumbnail load lifecycle (#959).
//
// `FilmstripCell` (FilmstripView.swift) and `FilmstripRailCell`
// (FilmstripRail.swift) each hand-rolled the same lazy-load / decode /
// cancel / memoise dance around `ThumbnailLoader.shared`. This extracts
// that lifecycle into one reusable view: callers only describe how to
// render the decoded bitmap (or the empty state while it's `nil`) via
// `content`, matching each cell's own chrome (corner radius, selection
// ring, arrival transition) without duplicating the load logic itself.

import SwiftUI
import MapleCore

struct AsyncThumbnail<Content: View>: View {
    let asset: AssetRef
    /// Source the asset came from — forwarded to `ThumbnailLoader` so the
    /// sourceless thumb path (cloud / PhotoKit / self-hosted) can resolve.
    /// `nil` for filesystem assets, which load straight off `primaryURL`.
    let source: (any ImageSource)?
    @ViewBuilder let content: (CGImage?) -> Content

    /// Decoded thumbnail bitmap from `ThumbnailLoader` + `ThumbnailDecoder`.
    /// `nil` while loading / on failure, in which case `content` renders its
    /// own empty state. Decoded off the main actor (never in `body`).
    @State private var decoded: CGImage?
    /// In-flight load task — cancelled on `.onDisappear` so scrolling a
    /// large filmstrip doesn't queue up redundant decodes.
    @State private var loadTask: Task<Void, Never>?
    /// Memoise the asset id we last loaded for, so recycled cells don't
    /// re-decode the same thumb when they re-appear.
    @State private var loadedForID: AssetRef.ID?

    var body: some View {
        content(decoded)
            .onAppear { startLoad() }
            .onDisappear {
                loadTask?.cancel()
                loadTask = nil
            }
    }

    private func startLoad() {
        if loadedForID == asset.id, decoded != nil { return }
        guard loadTask == nil else { return }
        let capturedAsset = asset
        let capturedSource = source
        loadTask = Task { @MainActor in
            let bytes = await ThumbnailLoader.shared.load(
                for: capturedAsset, from: capturedSource
            )
            guard !Task.isCancelled else { return }
            // Decode off the main actor before touching view state — never in
            // `body`. Keyed on the asset's stable id; no arrival fade (it
            // hitches scroll the same way it does in the grid).
            let image = await ThumbnailDecoder.image(
                for: bytes, key: capturedAsset.stableID ?? capturedAsset.id.uuidString)
            guard !Task.isCancelled else { return }
            decoded = image
            loadedForID = capturedAsset.id
            loadTask = nil
        }
    }
}
