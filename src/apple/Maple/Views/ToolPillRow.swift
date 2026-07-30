// ToolPillRow.swift — responsive-program S5a + S5c (#625).
//
// One pill per tool in the armed group: 40pt circle + 10pt label below.
// Default = surfaceAlt + 0.5pt border + glyph in textMain. Selected =
// `primary` opacity 0.15 fill, accent border, glyph + label in primary.
// Modified-indicator dot bottom-right of the circle when the tool's
// internal value is non-zero (positive = primary, negative = textMuted).
//
// Tools are laid out `flex: 1` (equal widths) while they fit the row.
// When the armed group has more tools than fit (Light/Effects on a narrow
// phone), the row falls back to a horizontal `ScrollView` at each pill's
// natural width so nothing is clipped or squeezed — `ViewThatFits` picks
// the equal-width layout first and the scrolling layout only on overflow.
//
// Spec: docs/design/responsive-program/s5-editor.md §2 + §5.

import SwiftUI
import MapleCore

struct ToolPillRow: View {
    @Bindable var state: EditorState
    /// Fires when the presets pill is tapped — the host (EditorView) opens
    /// the presets sheet (iOS) / popover (macOS). #1115.
    var onPresetsTap: () -> Void = {}

    var body: some View {
        let tools = state.visibleTools(in: state.armedGroup)
        ViewThatFits(in: .horizontal) {
            // Preferred: equal-width pills spanning the full row.
            toolRow(tools, fill: true)
            // Fallback when the group overflows: scroll at natural width.
            ScrollView(.horizontal, showsIndicators: false) {
                toolRow(tools, fill: false)
            }
        }
        .frame(minHeight: 60)
        .background(MapleTokens.bg)
        .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
        .accessibilityIdentifier("editor-tool-row")
    }

    @ViewBuilder
    private func toolRow(_ tools: [Tool], fill: Bool) -> some View {
        HStack(spacing: 4) {
            ForEach(tools, id: \.self) { tool in
                ToolPillButton(state: state, tool: tool, onPresetsTap: onPresetsTap)
                    .frame(maxWidth: fill ? .infinity : nil)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
    }
}

private struct ToolPillButton: View {
    @Bindable var state: EditorState
    let tool: Tool
    var onPresetsTap: () -> Void = {}

    private var isSelected: Bool { state.armedTool == tool }
    private var isModified: Bool {
        // Crop (#638) is intentionally `isWired == false` (no drag-bar value;
        // it arms the overlay instead — mirrors the web STUB_TOOLS decision),
        // but it still carries a persisted `AdjustmentModel.crop`, so its dot
        // must light whenever the crop is non-identity.
        if tool == .crop {
            return !state.session.model.crop.isIdentity
        }
        guard tool.isWired else { return false }
        // Multi-param pills (#1108): the dot lights when ANY sub-param is
        // off its canonical default (e.g. Noise with only Color raised).
        let subs = tool.subParams
        if !subs.isEmpty {
            return subs.contains { sub in
                abs(state.session.model[keyPath: sub.keyPath] - sub.defaultDisplayValue) > 1e-6
            }
        }
        let v = ToolValueMapping.currentDisplayValue(state.session.model, tool: tool)
        // Neutral display value isn't always zero (temp default = 6500,
        // Color NR default = 25). Pull from the canonical defaults table
        // so a fresh asset never shows the modified dot.
        let neutral = ToolValueMapping.defaultDisplayValue(for: tool)
        return abs(v - neutral) > 1e-6
    }

    var body: some View {
        Button {
            state.arm(tool: tool)
            if tool == .presets {
                onPresetsTap()
            }
        } label: {
            VStack(spacing: 6) {
                ZStack {
                    Circle()
                        .fill(isSelected
                              ? MapleTokens.primary.opacity(0.15)
                              : MapleTokens.surfaceAlt)
                        .overlay(
                            Circle().stroke(isSelected
                                            ? MapleTokens.primary
                                            : MapleTokens.border,
                                            lineWidth: 0.5)
                        )
                        .frame(width: 40, height: 40)
                    ToolGlyph.icon(for: tool, size: 18)
                        .foregroundStyle(isSelected
                                         ? MapleTokens.primary
                                         : MapleTokens.textMain)
                    if isModified {
                        Circle()
                            .fill(MapleTokens.primary)
                            .frame(width: 6, height: 6)
                            .offset(x: 14, y: 14)
                    }
                }
                Text(tool.displayName)
                    .font(.system(size: 10, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? MapleTokens.primary : MapleTokens.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tool.displayName)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("editor-tool-\(tool.rawValue)")
    }
}
