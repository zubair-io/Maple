// MuiSegmentedToggle.swift — Maple UI Segmented Toggle atom.
// Contract: docs/design/maple-ui/components/segmented-toggle.md

import SwiftUI

public struct MuiSegmentedOption: Identifiable, Hashable, Sendable {
    public let value: String
    public let label: String

    public var id: String { value }

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

/// A compact, exclusive picker for 2-3 closely related view modes
/// (segmented-toggle.md §Purpose) — the sliding-indicator alternative to a
/// row of separate toggle buttons.
public struct MuiSegmentedToggle: View {
    public let options: [MuiSegmentedOption]
    @Binding public var value: String
    public let disabled: Bool

    @Namespace private var indicatorNamespace
    @FocusState private var focusedValue: String?

    public init(options: [MuiSegmentedOption], value: Binding<String>, disabled: Bool = false) {
        self.options = options
        self._value = value
        self.disabled = disabled
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                segment(option)
            }
        }
        .padding(2)
        .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous))
        .opacity(disabled ? 0.45 : 1)
        // Radiogroup-equivalent: each segment below carries `.isSelected`
        // (segmented-toggle.md §Accessibility — "2 of 3, Grid" not three
        // unrelated buttons); grouping the segments themselves is enough
        // for VoiceOver to traverse them as one control.
        .accessibilityElement(children: .contain)
    }

    private func segment(_ option: MuiSegmentedOption) -> some View {
        let isSelected = option.value == value
        return Button {
            guard !disabled, !isSelected else { return }
            withAnimation(MuiTokens.Motion.groupSwap) { value = option.value }
        } label: {
            Text(option.label)
                .font(MuiTokens.TypeScale.font(.chipLabel))
                .foregroundStyle(isSelected ? MuiTokens.textMain : MuiTokens.textMuted)
                .padding(.horizontal, MuiTokens.spacingSm)
                .padding(.vertical, MuiTokens.spacingXs)
                .frame(minWidth: 44, minHeight: 28)
                .background {
                    if isSelected {
                        RoundedRectangle(cornerRadius: MuiTokens.radiusXs, style: .continuous)
                            .fill(MuiTokens.surfaceHover)
                            .matchedGeometryEffect(id: "indicator", in: indicatorNamespace)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .focused($focusedValue, equals: option.value)
        .overlay(
            RoundedRectangle(cornerRadius: MuiTokens.radiusXs, style: .continuous)
                .stroke(focusedValue == option.value ? MuiTokens.primary.opacity(0.2) : .clear, lineWidth: 2)
        )
        .accessibilityLabel(option.label)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

#Preview("MuiSegmentedToggle — 2 segments") {
    struct Demo: View {
        @State private var value = "grid"
        var body: some View {
            MuiSegmentedToggle(
                options: [
                    MuiSegmentedOption(value: "grid", label: "Grid"),
                    MuiSegmentedOption(value: "list", label: "List"),
                ],
                value: $value
            )
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiSegmentedToggle — 3 segments, disabled") {
    MuiSegmentedToggle(
        options: [
            MuiSegmentedOption(value: "grid", label: "Grid"),
            MuiSegmentedOption(value: "list", label: "List"),
            MuiSegmentedOption(value: "map", label: "Map"),
        ],
        value: .constant("list"),
        disabled: true
    )
    .padding()
    .background(MuiTokens.bg)
}
