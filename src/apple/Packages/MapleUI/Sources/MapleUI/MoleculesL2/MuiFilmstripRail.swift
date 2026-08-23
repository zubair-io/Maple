// MuiFilmstripRail.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Collapsible vertical thumbnails, built from Media Cell,
// Icon. Selection follows `activeId`, same contract as Filmstrip Row.

import SwiftUI

public struct MuiFilmstripRail: View {
    public let items: [MuiFilmstripItem]
    @Binding public var activeId: String?
    @Binding public var collapsed: Bool
    public let activated: ((String) -> Void)?

    public init(
        items: [MuiFilmstripItem],
        activeId: Binding<String?> = .constant(nil),
        collapsed: Binding<Bool> = .constant(false),
        activated: ((String) -> Void)? = nil
    ) {
        self.items = items
        self._activeId = activeId
        self._collapsed = collapsed
        self.activated = activated
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            Button {
                collapsed.toggle()
            } label: {
                MuiIcon(name: collapsed ? "chevron.right" : "chevron.down", size: .sm, color: MuiTokens.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(collapsed ? "Expand filmstrip" : "Collapse filmstrip")
            .accessibilityAddTraits(.isButton)

            if !collapsed {
                ScrollView {
                    VStack(spacing: MuiTokens.spacingXs) {
                        ForEach(items) { item in
                            MuiMediaCell(
                                url: item.url,
                                alt: item.alt,
                                filename: .constant(item.alt),
                                selected: item.id == activeId,
                                size: .sm,
                                pressed: { select(item.id) }
                            )
                        }
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Filmstrip")
            }
        }
        .animation(MuiTokens.Motion.groupSwap, value: collapsed)
    }

    private func select(_ id: String) {
        activeId = MuiFilmstripRow.nextActive(tapped: id)
        activated?(id)
    }
}

#Preview("MuiFilmstripRail") {
    HStack(alignment: .top, spacing: 24) {
        MuiFilmstripRail(
            items: [
                MuiFilmstripItem(id: "1", url: nil, alt: "Frame 1"),
                MuiFilmstripItem(id: "2", url: nil, alt: "Frame 2"),
            ],
            activeId: .constant("1")
        )
        MuiFilmstripRail(items: [MuiFilmstripItem(id: "1", url: nil, alt: "Frame 1")], collapsed: .constant(true))
    }
    .padding()
    .background(MuiTokens.bg)
}
