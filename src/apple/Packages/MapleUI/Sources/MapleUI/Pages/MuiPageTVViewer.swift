// MuiPageTVViewer.swift — Maple UI Pages (unified-component-catalog.md
// §6). App Shell hosting a single Preview Surface — the tvOS full-screen
// viewer reached from TV Timeline's Rediscover shelf. Same one-organism
// shape as MuiPagePreview; kept as its own page type (per the catalog's
// 15-page list) since tvOS drives it from the remote rather than touch,
// and its mock library is TV-flavored (slideshow-length dwell captions)
// rather than reusing Preview's.
//
// Preview Surface already owns its own active-item/filmstrip wiring
// (organism-tested), so there's no new page-level reducer here.

import SwiftUI

public struct MuiPageTVViewer: View {
    public let items: [MuiPreviewSurfaceItem]
    public let closed: (() -> Void)?

    @State private var activeId: String?

    public init(items: [MuiPreviewSurfaceItem] = MuiPageTVViewer.defaultItems, closed: (() -> Void)? = nil) {
        self.items = items
        self.closed = closed
        self._activeId = State(initialValue: items.first?.id)
    }

    public var body: some View {
        MuiAppShell {
            EmptyView()
        } content: {
            MuiPreviewSurface(
                items: items,
                activeId: $activeId,
                title: items.first(where: { $0.id == activeId })?.alt ?? "Now Playing",
                closed: closed
            )
        }
        .background(MuiTokens.bg)
    }

    // MARK: - Default mock data

    public static let defaultItems: [MuiPreviewSurfaceItem] = [
        MuiPreviewSurfaceItem(id: "1", kind: .image, url: nil, alt: "Glacier lagoon at dawn — Iceland, March 2026"),
        MuiPreviewSurfaceItem(id: "2", kind: .image, url: nil, alt: "Northern lights over a farmhouse — Iceland, March 2026"),
        MuiPreviewSurfaceItem(id: "3", kind: .video, url: nil, alt: "Drone pass over Jökulsárlón"),
    ]
}

#Preview("MuiPageTVViewer") {
    MuiPageTVViewer()
        .frame(width: 640, height: 400)
}
