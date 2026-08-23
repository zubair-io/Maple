// MuiListRow.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.2). Contract: docs/design/maple-ui/components/list-row.md. Row with
// metadata and inline actions, built from Icon, Text, Timestamp, Button —
// the base horizontal row primitive for settings rows, tree/folder rows,
// and filterable list items.
//
// Contract notes followed exactly: Active is `surface_alt` fill + a 2pt
// `primary` left border — never a full primary fill. Active composes with
// (doesn't replace) Hover, since Active is a persistent selection state,
// not a transient interaction state. `trailing` is a projected `@ViewBuilder`
// slot (value text, icon, toggle, chevron, or a button), not a fixed enum,
// since trailing content varies per call site.

import SwiftUI

public struct MuiListRow<Trailing: View>: View {
    public let icon: String?
    public let label: String
    /// Plain-text subtitle. Ignored when `timestampValue` is set.
    public let subtitle: String?
    /// Renders the subtitle as a relative `MuiTimestamp` instead of plain
    /// text (e.g. "Edited 2m ago"). Takes priority over `subtitle`.
    public let timestampValue: Date?
    public let active: Bool
    public let disabled: Bool
    public let pressed: (() -> Void)?
    public let trailing: Trailing

    @State private var isHovering = false

    public init(
        icon: String? = nil,
        label: String,
        subtitle: String? = nil,
        timestampValue: Date? = nil,
        active: Bool = false,
        disabled: Bool = false,
        pressed: (() -> Void)? = nil,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() }
    ) {
        self.icon = icon
        self.label = label
        self.subtitle = subtitle
        self.timestampValue = timestampValue
        self.active = active
        self.disabled = disabled
        self.pressed = pressed
        self.trailing = trailing()
    }

    public var body: some View {
        Button {
            guard !disabled else { return }
            pressed?()
        } label: {
            HStack(spacing: MuiTokens.spacingSm) {
                if let icon {
                    MuiIcon(name: icon, size: .sm, color: MuiTokens.textMuted)
                }

                VStack(alignment: .leading, spacing: 2) {
                    MuiText(label, variant: .rowLabel, truncate: true)
                    if let timestampValue {
                        MuiTimestamp(value: timestampValue, format: .relative)
                    } else if let subtitle {
                        MuiText(subtitle, variant: .body, color: .muted, truncate: true)
                    }
                }

                Spacer(minLength: MuiTokens.spacingSm)

                trailing
            }
            .padding(.horizontal, MuiTokens.spacingMd)
            .padding(.vertical, MuiTokens.spacingSm)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(backgroundColor)
            .overlay(alignment: .leading) {
                if active {
                    Rectangle().fill(MuiTokens.primary).frame(width: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.45 : 1)
        .onHover { isHovering = $0 }
        .accessibilityLabel(label)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : .isButton)
    }

    private var backgroundColor: Color {
        if active { return MuiTokens.surfaceAlt }
        if isHovering { return MuiTokens.surfaceHover }
        return .clear
    }
}

#Preview("MuiListRow") {
    VStack(spacing: 0) {
        MuiListRow(icon: "gearshape", label: "General", active: true, trailing: {
            MuiIcon(name: "chevron.right", size: .sm, color: MuiTokens.textMuted)
        })
        MuiListRow(icon: "bell", label: "Notifications", subtitle: "On for mentions", trailing: {
            MuiIcon(name: "chevron.right", size: .sm, color: MuiTokens.textMuted)
        })
        MuiListRow(icon: "doc", label: "IMG_0042.dng", timestampValue: Date().addingTimeInterval(-120))
        MuiListRow(icon: "lock", label: "Locked", disabled: true)
    }
    .padding()
    .background(MuiTokens.bg)
}
