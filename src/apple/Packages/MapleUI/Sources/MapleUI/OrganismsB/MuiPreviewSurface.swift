// MuiPreviewSurface.swift — Maple UI Organisms · Editing surfaces
// (unified-component-catalog.md §4.5). A full-screen media preview: a
// header with a back action and a zoom/rotate/info toolbar, a stage that
// swaps between an image and a video player depending on the active item's
// kind, and a bottom filmstrip for picking a different item. Built from
// Page Header, Filmstrip, Preview Image, Video Player, Toolbar.

import SwiftUI

public enum MuiPreviewSurfaceItemKind: Sendable {
    case image, video
}

public struct MuiPreviewSurfaceItem: Identifiable, Sendable {
    public let id: String
    public let kind: MuiPreviewSurfaceItemKind
    public let url: URL?
    public let alt: String

    public init(id: String, kind: MuiPreviewSurfaceItemKind, url: URL?, alt: String) {
        self.id = id
        self.kind = kind
        self.url = url
        self.alt = alt
    }
}

public struct MuiPreviewSurface: View {
    public let items: [MuiPreviewSurfaceItem]
    @Binding public var activeId: String?
    public let title: String
    public let closed: (() -> Void)?
    public let toolbarAction: ((String) -> Void)?

    private static let toolbarEntries: [MuiToolbarEntry] = [
        .item(MuiToolbarActionItem(id: "zoom-in", icon: "plus.magnifyingglass", label: "Zoom in")),
        .item(MuiToolbarActionItem(id: "zoom-out", icon: "minus.magnifyingglass", label: "Zoom out")),
        .item(MuiToolbarActionItem(id: "rotate", icon: "rotate.right", label: "Rotate")),
        .divider,
        .item(MuiToolbarActionItem(id: "info", icon: "info.circle", label: "Info")),
    ]

    public init(
        items: [MuiPreviewSurfaceItem],
        activeId: Binding<String?>,
        title: String = "Preview",
        closed: (() -> Void)? = nil,
        toolbarAction: ((String) -> Void)? = nil
    ) {
        self.items = items
        self._activeId = activeId
        self.title = title
        self.closed = closed
        self.toolbarAction = toolbarAction
    }

    private var activeItem: MuiPreviewSurfaceItem? {
        items.first { $0.id == activeId }
    }

    public var body: some View {
        VStack(spacing: 0) {
            MuiPageHeader(title: title, back: closed, actions: {
                MuiToolbar(entries: Self.toolbarEntries, itemSelected: { toolbarAction?($0) })
            })

            MuiDivider()

            stage
                .frame(maxHeight: .infinity)

            MuiDivider()

            MuiFilmstripRow(
                items: items.map { MuiFilmstripItem(id: $0.id, url: $0.url, alt: $0.alt) },
                activeId: $activeId
            )
            .padding(MuiTokens.spacingSm)
        }
    }

    @ViewBuilder
    private var stage: some View {
        if let activeItem {
            switch activeItem.kind {
            case .image:
                MuiPreviewImage(url: activeItem.url, alt: activeItem.alt, fit: .fit, radius: .none)
            case .video:
                MuiVideoPlayer(url: activeItem.url, accessibilityLabel: activeItem.alt)
            }
        } else {
            MuiEmptyState(icon: "photo", title: "No item selected")
        }
    }
}

#Preview("MuiPreviewSurface") {
    struct Demo: View {
        @State private var active: String? = "1"
        var body: some View {
            MuiPreviewSurface(
                items: [
                    MuiPreviewSurfaceItem(id: "1", kind: .image, url: nil, alt: "Iceland glacier"),
                    MuiPreviewSurfaceItem(id: "2", kind: .video, url: nil, alt: "Trip clip"),
                ],
                activeId: $active,
                title: "IMG_0042.dng"
            )
            .frame(width: 360, height: 320)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
