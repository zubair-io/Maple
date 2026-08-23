// MuiFilmstripRow.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Horizontal scrolling thumbnails, built from Media Cell.
// Selection follows `activeId`: tapping a cell moves `activeId` to it and
// auto-scrolls it into view (no direct web-reference equivalent — the
// scroll-follow is a native affordance CSS overflow gives the web version
// for free, so `ScrollViewReader` reproduces it explicitly here).

import SwiftUI

public struct MuiFilmstripItem: Identifiable, Sendable {
    public let id: String
    public let url: URL?
    public let alt: String

    public init(id: String, url: URL?, alt: String) {
        self.id = id
        self.url = url
        self.alt = alt
    }
}

public struct MuiFilmstripRow: View {
    public let items: [MuiFilmstripItem]
    @Binding public var activeId: String?
    public let activated: ((String) -> Void)?

    public init(items: [MuiFilmstripItem], activeId: Binding<String?> = .constant(nil), activated: ((String) -> Void)? = nil) {
        self.items = items
        self._activeId = activeId
        self.activated = activated
    }

    public var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: MuiTokens.spacingXs) {
                    ForEach(items) { item in
                        MuiMediaCell(
                            url: item.url,
                            alt: item.alt,
                            filename: .constant(item.alt),
                            selected: item.id == activeId,
                            size: .sm,
                            pressed: { select(item.id) }
                        )
                        .id(item.id)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Filmstrip")
            .onChange(of: activeId) { _, newValue in
                guard let newValue else { return }
                withAnimation(MuiTokens.Motion.groupSwap) { proxy.scrollTo(newValue, anchor: .center) }
            }
        }
    }

    private func select(_ id: String) {
        activeId = Self.nextActive(tapped: id)
        activated?(id)
    }

    /// The next `activeId` for a tapped cell — always the tapped item's id.
    /// Public + static so this is unit-testable without rendering a view.
    public static func nextActive(tapped: String) -> String {
        tapped
    }
}

#Preview("MuiFilmstripRow") {
    MuiFilmstripRow(
        items: [
            MuiFilmstripItem(id: "1", url: nil, alt: "Frame 1"),
            MuiFilmstripItem(id: "2", url: nil, alt: "Frame 2"),
            MuiFilmstripItem(id: "3", url: nil, alt: "Frame 3"),
        ],
        activeId: .constant("2")
    )
    .padding()
    .background(MuiTokens.bg)
}
