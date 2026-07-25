// MobileControlBar.swift — Pro Editor Canvas-first (control-variant exploration).
//
// Compact (iPhone) layout replacement for ControlCard in the `.compact`
// control variant.  A bottom-anchored VStack with two glass cards:
//
//   ┌─────────────────────────────────────────────────────┐
//   │  [icon]  GROUP NAME       [↺ reset]                 │  ← header
//   │  ─────────────────────────────────────────────────  │
//   │  Exposure          ●──────────────────  +0.20       │  ← sliders
//   │  Contrast          ────────●──────────  0           │    (or CropToolbar
//   │  …                                                   │     while crop armed)
//   └─────────────────────────────────────────────────────┘
//   ┌─ Light · Color · Effects · Detail · Crop · Presets ─┐
//   │  [☀]  [🎨]  [✨]  [◎]  [↳crop]  [⊞presets]  …     │  ← button bar
//   └─────────────────────────────────────────────────────┘
//
// The slider panel (top card) mirrors FlyoutSliderPanel exactly — same
// header, same wiredTools filter, same sub-param / color-accessory / crop
// rows — but uses full width instead of a fixed 300pt column.
//
// The button bar (bottom card) is a horizontal ScrollView of icon+label
// buttons, visually identical to GroupDockButton / SpecialDockButton in
// ToolDock.swift (36pt icon circle + 9pt label) but laid out in a row.
//
// TEMPORARY: part of the control-variant exploration (see EditorView).
// Remove with the rest of the exploration when the design review concludes.

import SwiftUI
import MapleCore

// MARK: - MobileControlBar

struct MobileControlBar: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    var body: some View {
        VStack(spacing: 8) {
            sliderPanel
            buttonBar
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
        .accessibilityIdentifier("editor-mobile-bar")
    }

    // MARK: - Slider panel

    private var sliderPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            sliderPanelHeader

            if state.armedTool == .crop {
                CropToolbar(state: state)
            } else if state.armedTool == .hsl {
                // 8-band HSL panel replaces the group slider stack (#274).
                HSLSection(state: state)
            } else {
                let subs = state.armedSubParams
                if subs.count > 1 {
                    SubParamRow(state: state)
                }
                if state.armedGroup == .color {
                    ColorAccessoryRow(state: state)
                        .transition(.opacity)
                }
                VStack(spacing: 10) {
                    ForEach(wiredTools, id: \.self) { tool in
                        LivingSliderRow(state: state, tool: tool)
                    }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .background(
            ProTokens.bg.opacity(ProGlass.opacity),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
        .accessibilityIdentifier("editor-mobile-slider-panel")
    }

    private var sliderPanelHeader: some View {
        HStack(spacing: 6) {
            Image(systemName: groupSymbol(state.armedGroup))
                .font(.system(size: 12, weight: .regular))
                .foregroundStyle(ProTokens.accent)
            Text(state.armedGroup.displayName.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(ProTokens.accent)
                .animation(.none, value: state.armedGroup)

            Spacer(minLength: 0)

            Button {
                resetActiveGroup()
            } label: {
                Image(systemName: "arrow.counterclockwise")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(ProTokens.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Reset \(state.armedGroup.displayName) adjustments")
            .accessibilityIdentifier("editor-mobile-reset-group")
        }
    }

    // MARK: - Button bar

    private var buttonBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                // ── 4 group buttons ──────────────────────────────────────────
                ForEach(ToolGroup.allCases, id: \.self) { group in
                    MobileGroupButton(state: state, group: group)
                }

                // ── Special tool buttons ─────────────────────────────────────
                MobileToolButton(
                    state: state,
                    tool: .crop,
                    onPresetsTap: onPresetsTap
                )
                MobileToolButton(
                    state: state,
                    tool: .presets,
                    onPresetsTap: onPresetsTap
                )

                // ── Disabled placeholders ────────────────────────────────────
                MobileDisabledPlaceholder(symbol: "lasso", label: "Mask")
                MobileDisabledPlaceholder(symbol: "bandage", label: "Heal")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 10)
        }
        .frame(maxWidth: .infinity)
        .background(
            ProTokens.bg.opacity(ProGlass.opacity),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .accessibilityIdentifier("editor-mobile-button-bar")
    }

    // MARK: - Helpers (mirrors FlyoutSliderPanel)

    /// Wired, slider-backed tools in the armed group.
    private var wiredTools: [Tool] {
        Tool.tools(in: state.armedGroup)
            .filter { $0.isWired && ToolValueMapping.displayRange(for: $0) != nil }
    }

    /// SF Symbols for the group icon — mirrors ToolDock.GroupDockButton.symbol.
    private func groupSymbol(_ group: ToolGroup) -> String {
        switch group {
        case .light:   return "sun.max"
        case .color:   return "paintpalette"
        case .effects: return "sparkles"
        case .detail:  return "camera.aperture"
        }
    }

    /// Resets all wired tools in the armed group to their canonical defaults,
    /// one undo boundary — mirrors FlyoutSliderPanel.resetActiveGroup().
    private func resetActiveGroup() {
        let tools = wiredTools
        guard !tools.isEmpty else { return }
        state.commit()
        for tool in tools {
            ToolValueMapping.apply(
                ToolValueMapping.defaultDisplayValue(for: tool),
                to: &state.session.model,
                tool: tool
            )
        }
    }
}

// MARK: - MobileGroupButton

/// Horizontal-bar version of ToolDock.GroupDockButton: same 36pt icon circle
/// + 9pt label, same active style (accent fill + accent border + accent text).
private struct MobileGroupButton: View {
    @Bindable var state: EditorState
    let group: ToolGroup

    private var isSelected: Bool { state.armedGroup == group }

    private var symbol: String {
        switch group {
        case .light:   return "sun.max"
        case .color:   return "paintpalette"
        case .effects: return "sparkles"
        case .detail:  return "camera.aperture"
        }
    }

    var body: some View {
        Button {
            withAnimation(MapleTokens.Motion.groupSwap) { state.arm(group: group) }
        } label: {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .fill(isSelected ? ProTokens.accent(0x28) : ProTokens.panel)
                        .overlay(
                            Circle().stroke(
                                isSelected ? ProTokens.accent : ProTokens.border,
                                lineWidth: 0.5
                            )
                        )
                        .frame(width: 36, height: 36)

                    Image(systemName: symbol)
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.text)
                }
                Text(group.displayName)
                    .font(.system(size: 9, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.textMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(width: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(group.displayName)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("editor-mobilebar-group-\(group.rawValue)")
    }
}

// MARK: - MobileToolButton

/// Horizontal-bar version of ToolDock.SpecialDockButton (Crop / Presets).
private struct MobileToolButton: View {
    @Bindable var state: EditorState
    let tool: Tool
    var onPresetsTap: () -> Void = {}

    private var isSelected: Bool { state.armedTool == tool }

    var body: some View {
        Button {
            state.arm(tool: tool)
            if tool == .presets { onPresetsTap() }
        } label: {
            VStack(spacing: 4) {
                ZStack {
                    Circle()
                        .fill(isSelected ? ProTokens.accent(0x28) : ProTokens.panel)
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
        .accessibilityIdentifier("editor-mobilebar-tool-\(tool.rawValue)")
    }
}

// MARK: - MobileDisabledPlaceholder

/// Horizontal-bar version of ToolDock.DisabledDockPlaceholder.
private struct MobileDisabledPlaceholder: View {
    let symbol: String
    let label: String

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(ProTokens.panel)
                    .overlay(Circle().stroke(ProTokens.border, lineWidth: 0.5))
                    .frame(width: 36, height: 36)

                Image(systemName: symbol)
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(ProTokens.textDim)
            }
            Text(label)
                .font(.system(size: 9, weight: .regular))
                .foregroundStyle(ProTokens.textDim)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(width: 52)
        .opacity(0.40)
        .accessibilityHidden(true)
    }
}
