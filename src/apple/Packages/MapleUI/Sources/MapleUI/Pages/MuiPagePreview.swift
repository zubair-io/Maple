// MuiPagePreview.swift — Maple UI Pages (unified-component-catalog.md §6).
// App Shell hosting a single Preview Surface — the full-screen media
// viewer reached from Browse or Search. App Shell's Nav region collapses
// to nothing here: Preview Surface already carries its own header and
// toolbar, so a second nav bar above it would just be a duplicate one.
//
// Preview Surface already owns its own active-item/filmstrip wiring
// (tested at the organism tier), so there's no new cross-organism reducer
// to add here — this page's only job is to own the mock item list and the
// `activeId` it's driven by, matching the catalog's one-organism-per-page
// shape for Preview.

import SwiftUI

public struct MuiPagePreview: View {
    public let items: [MuiPreviewSurfaceItem]
    public let closed: (() -> Void)?

    @State private var activeId: String?

    public init(items: [MuiPreviewSurfaceItem] = MuiPagePreview.defaultItems, closed: (() -> Void)? = nil) {
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
                title: items.first(where: { $0.id == activeId })?.alt ?? "Preview",
                closed: closed
            )
        }
        .background(MuiTokens.bg)
    }

    // MARK: - Default mock data

    public static let defaultItems: [MuiPreviewSurfaceItem] = [
        MuiPreviewSurfaceItem(id: "1", kind: .image, url: nil, alt: "IMG_0401.dng — Glacier lagoon at dawn"),
        MuiPreviewSurfaceItem(id: "2", kind: .image, url: nil, alt: "IMG_0417.dng — Northern lights over a farmhouse"),
        MuiPreviewSurfaceItem(id: "3", kind: .video, url: nil, alt: "MVI_0044.mov — Drone pass over Jökulsárlón"),
    ]
}

#Preview("MuiPagePreview") {
    MuiPagePreview()
        .frame(width: 500, height: 420)
}
