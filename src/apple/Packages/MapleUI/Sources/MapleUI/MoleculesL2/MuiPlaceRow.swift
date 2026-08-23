// MuiPlaceRow.swift — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Geocoded place with override, built from Text, Input, Button.
// Displays the resolved place name; tapping it swaps in an Input to
// override, with a Clear action that drops the override back to the
// geocoded value. Unlike MuiDescriptionField, an empty override is never
// committed — clearing a place goes through the explicit Clear action, not
// a blank Input commit.

import SwiftUI

public struct MuiPlaceRow: View {
    @Binding public var place: String
    public let overridden: Bool
    public let committed: ((String) -> Void)?
    public let cleared: (() -> Void)?

    @State private var editing = false
    @State private var draft = ""
    @FocusState private var isFocused: Bool

    public init(
        place: Binding<String>,
        overridden: Bool = false,
        committed: ((String) -> Void)? = nil,
        cleared: (() -> Void)? = nil
    ) {
        self._place = place
        self.overridden = overridden
        self.committed = committed
        self.cleared = cleared
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingSm) {
            if editing {
                MuiInput(value: $draft, accessibilityLabel: "Place", onCommit: commit)
                    .focused($isFocused)
                    #if os(macOS)
                    .onExitCommand { editing = false }
                    #endif
                    .onChange(of: isFocused) { _, focused in
                        if !focused { commit() }
                    }
                    .task { isFocused = true }
            } else {
                Button {
                    draft = place
                    editing = true
                } label: {
                    MuiText(place.isEmpty ? "Unknown location" : place, variant: .rowLabel, truncate: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Place")

                if overridden {
                    MuiButton(label: "Clear override", variant: .ghost, size: .sm, leadingIcon: "arrow.uturn.backward", iconOnly: true) {
                        cleared?()
                    }
                }
            }
        }
    }

    private func commit() {
        guard editing else { return }
        editing = false
        guard let next = Self.commitResult(current: place, draft: draft) else { return }
        place = next
        committed?(next)
    }

    /// The committed value for an edit attempt — `nil` when the trimmed
    /// draft is unchanged from the current value, or blank (a place
    /// override is never committed empty; clearing goes through
    /// `cleared`, not a blank commit). Public + static so this is
    /// unit-testable without rendering a view.
    public static func commitResult(current: String, draft: String) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != current else { return nil }
        return trimmed
    }
}

#Preview("MuiPlaceRow") {
    struct Demo: View {
        @State private var place = "Reykjavík, Iceland"
        @State private var unknown = ""

        var body: some View {
            VStack(alignment: .leading, spacing: 16) {
                MuiPlaceRow(place: $place, overridden: true)
                MuiPlaceRow(place: $unknown)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
