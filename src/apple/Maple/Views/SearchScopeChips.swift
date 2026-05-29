// SearchScopeChips.swift — single-select scope row for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2.
//
// Renders one chip per `SearchScope` case. Tap fires the binding setter
// — the host (SearchView) issues a fresh search call with the scope
// mapped into `SearchParams`. v0.1 only `all` and `photos` round-trip
// to the backend (same call); `places`, `people`, `albums` are stubbed
// until a backend `scope` extension lands (see spec §6 Risks).

#if os(iOS)

import SwiftUI
import MapleCore

/// User-facing scope chip enum. Mirrors the web `SearchScope` union.
enum SearchScope: String, CaseIterable, Identifiable {
    case all
    case photos
    case places
    case people
    case albums

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all:    "All"
        case .photos: "Photos"
        case .places: "Places"
        case .people: "People"
        case .albums: "Albums"
        }
    }
}

struct SearchScopeChips: View {
    @Binding var scope: SearchScope

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(SearchScope.allCases) { value in
                    chip(for: value)
                }
            }
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func chip(for value: SearchScope) -> some View {
        let selected = value == scope
        Button {
            if !selected { scope = value }
        } label: {
            Text(value.label)
                .font(.custom("Lato-Bold", size: 11))
                .foregroundStyle(selected ? Color.white : MapleTokens.textMain)
                .padding(.horizontal, 12)
                .frame(height: 28)
                .background(selected ? MapleTokens.primary : MapleTokens.surfaceAlt)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(selected ? MapleTokens.primary : MapleTokens.border, lineWidth: 0.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("search-scope-\(value.rawValue)")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

#Preview("SearchScopeChips — All selected") {
    PreviewWrapper(scope: .all)
        .padding()
        .background(MapleTokens.bg)
}

#Preview("SearchScopeChips — Photos selected") {
    PreviewWrapper(scope: .photos)
        .padding()
        .background(MapleTokens.bg)
}

private struct PreviewWrapper: View {
    @State var scope: SearchScope
    var body: some View {
        SearchScopeChips(scope: $scope)
    }
}

#endif
