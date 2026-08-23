// MuiSearchBar.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.1). Query pill with clear, built from Icon + Input + Button — the
// leading icon and clear affordance come from Input's search-style slots,
// and an optional trailing ghost Button covers a filters/action trigger.

import SwiftUI

public struct MuiSearchBar: View {
    @Binding public var value: String
    public let placeholder: String
    public let disabled: Bool
    public let actionLabel: String?
    public let actionIcon: String?
    public let committed: (() -> Void)?
    public let actionPressed: (() -> Void)?

    public init(
        value: Binding<String>,
        placeholder: String = "Search",
        disabled: Bool = false,
        actionLabel: String? = nil,
        actionIcon: String? = nil,
        committed: (() -> Void)? = nil,
        actionPressed: (() -> Void)? = nil
    ) {
        self._value = value
        self.placeholder = placeholder
        self.disabled = disabled
        self.actionLabel = actionLabel
        self.actionIcon = actionIcon
        self.committed = committed
        self.actionPressed = actionPressed
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingSm) {
            MuiInput(
                value: $value,
                accessibilityLabel: placeholder,
                placeholder: placeholder,
                prefixIcon: "magnifyingglass",
                showClear: true,
                disabled: disabled,
                onCommit: committed
            )

            if let actionLabel {
                MuiButton(label: actionLabel, variant: .ghost, size: .sm, leadingIcon: actionIcon, disabled: disabled) {
                    actionPressed?()
                }
            }
        }
    }
}

#Preview("MuiSearchBar") {
    struct Demo: View {
        @State private var query = ""
        @State private var filtered = "sunset"

        var body: some View {
            VStack(spacing: 12) {
                MuiSearchBar(value: $query, placeholder: "Search photos…")
                MuiSearchBar(value: $filtered, placeholder: "Search", actionLabel: "Filters", actionIcon: "line.3.horizontal.decrease")
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
