// MuiFilmstrip.swift — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Focus-following thumbnail strip,
// built from Filmstrip Row, Filmstrip Rail — a thin orientation switcher
// between the two (already-shipped MoleculesL2 wave A4 elements).
//
// Filmstrip Row/Rail already degrade gracefully to an empty strip with no
// items, so this organism adds no loading/empty/error chrome of its own —
// doing so would just duplicate what the children already handle.
//
// Known gap vs. the web reference: the web version additionally scrolls
// the active cell into view on every `activeId` change via a direct DOM
// query, because its Filmstrip Row/Rail don't own that behavior
// themselves. Neither Swift molecule exposes a `ScrollViewProxy` to an
// outer view, so replicating that here would mean changing the two
// already-shipped molecules — out of scope for this organism wave. Both
// molecules keep the active cell rendered with a selection ring, so it's
// always visible once scrolled to manually.

import SwiftUI

/// Horizontal (row) or vertical (rail) presentation.
public enum MuiFilmstripOrientation: Sendable {
    case horizontal, vertical
}

public struct MuiFilmstrip: View {
    public let items: [MuiFilmstripItem]
    public let orientation: MuiFilmstripOrientation
    @Binding public var activeId: String?
    @Binding public var collapsed: Bool
    public let activated: ((String) -> Void)?

    public init(
        items: [MuiFilmstripItem],
        orientation: MuiFilmstripOrientation = .horizontal,
        activeId: Binding<String?> = .constant(nil),
        collapsed: Binding<Bool> = .constant(false),
        activated: ((String) -> Void)? = nil
    ) {
        self.items = items
        self.orientation = orientation
        self._activeId = activeId
        self._collapsed = collapsed
        self.activated = activated
    }

    public var body: some View {
        switch orientation {
        case .horizontal:
            MuiFilmstripRow(items: items, activeId: $activeId, activated: activated)
        case .vertical:
            MuiFilmstripRail(items: items, activeId: $activeId, collapsed: $collapsed, activated: activated)
        }
    }
}

#Preview("MuiFilmstrip — Horizontal") {
    struct Demo: View {
        @State private var active: String? = "2"
        var body: some View {
            MuiFilmstrip(
                items: (1...8).map { MuiFilmstripItem(id: "\($0)", url: nil, alt: "Frame \($0)") },
                orientation: .horizontal,
                activeId: $active
            )
            .frame(height: 100)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiFilmstrip — Vertical") {
    struct Demo: View {
        @State private var active: String? = "2"
        @State private var collapsed = false
        var body: some View {
            MuiFilmstrip(
                items: (1...8).map { MuiFilmstripItem(id: "\($0)", url: nil, alt: "Frame \($0)") },
                orientation: .vertical,
                activeId: $active,
                collapsed: $collapsed
            )
            .frame(width: 100, height: 320)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
