// ToolDock.swift — Pro Editor Canvas-first (A2, #1555).
//
// Vertical glass column of tool-group pills on the trailing edge of the
// canvas-first editor (regular size class only).  Reoriented from the
// horizontal `ToolPillRow`: shows the tools for the currently-armed group
// in a vertically-centered scroll, each a 36pt circle + label with the
// selected accent fill / ring and the modified-value dot.

import SwiftUI
import MapleCore

struct ToolDock: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    var body: some View {
        let tools = Tool.tools(in: state.armedGroup)
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 6) {
                ForEach(tools, id: \.self) { tool in
                    ToolDockButton(state: state, tool: tool, onPresetsTap: onPresetsTap)
                }
            }
            .padding(.vertical, 10)
        }
        .frame(width: 64)
        .background(ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 12))
        .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
        .accessibilityIdentifier("editor-tool-dock")
    }
}

// MARK: - ToolDockButton

private struct ToolDockButton: View {
    @Bindable var state: EditorState
    let tool: Tool
    var onPresetsTap: () -> Void = {}

    private var isSelected: Bool { state.armedTool == tool }

    private var isModified: Bool {
        if tool == .crop { return !state.session.model.crop.isIdentity }
        guard tool.isWired else { return false }
        let subs = tool.subParams
        if !subs.isEmpty {
            return subs.contains { sub in
                abs(state.session.model[keyPath: sub.keyPath] - sub.defaultDisplayValue) > 1e-6
            }
        }
        let v = ToolValueMapping.currentDisplayValue(state.session.model, tool: tool)
        let neutral = ToolValueMapping.defaultDisplayValue(for: tool)
        return abs(v - neutral) > 1e-6
    }

    var body: some View {
        Button {
            state.arm(tool: tool)
            if tool == .presets { onPresetsTap() }
        } label: {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .fill(isSelected
                              ? ProTokens.accent(0x28)
                              : ProTokens.panel)
                        .overlay(
                            Circle().stroke(
                                isSelected ? ProTokens.accent : ProTokens.border,
                                lineWidth: 0.5
                            )
                        )
                        .frame(width: 36, height: 36)

                    Image(systemName: ToolGlyph.sfSymbol(for: tool))
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.text)

                    if isModified {
                        Circle()
                            .fill(ProTokens.accent)
                            .frame(width: 5, height: 5)
                            .offset(x: 12, y: 12)
                    }
                }
                Text(tool.displayName)
                    .font(.system(size: 9, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(width: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tool.displayName)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("editor-dock-tool-\(tool.rawValue)")
    }
}
