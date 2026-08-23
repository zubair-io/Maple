// MuiTreeRow.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.2). One row of a hierarchical tree, built from Icon, Text, Badge,
// Spinner.

import SwiftUI

public struct MuiTreeRow: View {
    public let label: String
    public let icon: String
    /// Shows a leading chevron and toggles `expanded` when there are
    /// children.
    public let expandable: Bool
    @Binding public var expanded: Bool
    /// Indentation level — each level adds one indent unit.
    public let depth: Int
    public let count: Int?
    public let loading: Bool
    public let active: Bool
    public let disabled: Bool
    public let pressed: (() -> Void)?

    public init(
        label: String,
        icon: String = "folder",
        expandable: Bool = false,
        expanded: Binding<Bool> = .constant(false),
        depth: Int = 0,
        count: Int? = nil,
        loading: Bool = false,
        active: Bool = false,
        disabled: Bool = false,
        pressed: (() -> Void)? = nil
    ) {
        self.label = label
        self.icon = icon
        self.expandable = expandable
        self._expanded = expanded
        self.depth = depth
        self.count = count
        self.loading = loading
        self.active = active
        self.disabled = disabled
        self.pressed = pressed
    }

    public var body: some View {
        Button {
            guard !disabled else { return }
            pressed?()
        } label: {
            HStack(spacing: MuiTokens.spacingXs) {
                if expandable {
                    Button {
                        expanded.toggle()
                    } label: {
                        MuiIcon(name: "chevron.right", size: .sm, color: MuiTokens.textMuted)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(expanded ? "Collapse" : "Expand")
                } else {
                    Color.clear.frame(width: MuiIconSize.sm.points, height: MuiIconSize.sm.points)
                }

                MuiIcon(name: icon, size: .sm, color: MuiTokens.textMuted)
                MuiText(label, variant: .rowLabel, truncate: true)

                Spacer(minLength: MuiTokens.spacingXs)

                if loading {
                    MuiSpinner(size: .sm)
                } else if let count {
                    MuiBadge(variant: .count, value: "\(count)")
                }
            }
            .padding(.leading, CGFloat(depth) * 16)
            .padding(.horizontal, MuiTokens.spacingMd)
            .padding(.vertical, MuiTokens.spacingSm)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(rowBackground)
            .overlay(alignment: .leading) {
                if active {
                    Rectangle().fill(MuiTokens.primary).frame(width: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
    }

    private var rowBackground: Color {
        active ? MuiTokens.surfaceAlt : .clear
    }
}

#Preview("MuiTreeRow") {
    struct Demo: View {
        @State private var expanded = true

        var body: some View {
            VStack(spacing: 0) {
                MuiTreeRow(label: "2026 Trips", expandable: true, expanded: $expanded)
                MuiTreeRow(label: "Iceland", depth: 1, count: 214, active: true)
                MuiTreeRow(label: "Faroe Islands", depth: 1, loading: true)
                MuiTreeRow(label: "Archived", disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
