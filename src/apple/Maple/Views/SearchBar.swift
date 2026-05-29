// SearchBar.swift — 38pt pill search field for responsive-program S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2 "Phone".
//
// The caret is the SwiftUI system caret tinted via `.accentColor`/`tint`
// to MapleTokens.primary; SwiftUI uses a 500ms blink cadence by default
// on iOS so we don't need a custom timer. The trailing ✕ appears once
// the query has ≥1 char.

#if os(iOS)

import SwiftUI
import MapleCore

struct SearchBar: View {
    @Binding var query: String
    var onSubmit: () -> Void = {}
    var onClear: () -> Void = {}
    /// Bound to the parent's `@FocusState` so the host can pull focus on
    /// tab activation, `.mapleFocusSearch` notification, etc.
    @FocusState.Binding var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(MapleTokens.textMuted)
                .font(.system(size: 14, weight: .regular))

            TextField("Search", text: $query)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .focused($isFocused)
                .tint(MapleTokens.primary)
                .accessibilityLabel("Search photos")
                .accessibilityIdentifier("search-input")
                .onSubmit(onSubmit)

            if !query.isEmpty {
                Button {
                    onClear()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(MapleTokens.textMuted)
                        .frame(width: 20, height: 20)
                        .background(MapleTokens.surfaceAlt, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
                .accessibilityIdentifier("search-clear")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 38)
        .background(MapleTokens.inputBg)
        .overlay(
            RoundedRectangle(cornerRadius: 19, style: .continuous)
                .stroke(MapleTokens.border, lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
    }
}

#Preview("SearchBar — empty") {
    PreviewWrapper(query: "")
        .padding()
        .background(MapleTokens.bg)
}

#Preview("SearchBar — with query") {
    PreviewWrapper(query: "paris")
        .padding()
        .background(MapleTokens.bg)
}

private struct PreviewWrapper: View {
    @State var query: String
    @FocusState var focused: Bool
    var body: some View {
        SearchBar(query: $query, isFocused: $focused)
    }
}

#endif
