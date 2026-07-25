// ToolDock.swift — Pro Editor Canvas-first (A2, #1555).
//
// Vertical glass column on the trailing edge of the canvas-first editor
// (regular size class only).
//
// Control-variant A (.compact) layout:
//   • Top section: GROUP buttons — Light / Color / Effects / Detail.
//     Tapping arms the group and switches the ControlCard to that group's sliders.
//   • Divider.
//   • Bottom section: SPECIAL TOOL buttons — Crop and Presets (the only two
//     Tool cases in the Detail group that aren't plain sliders).  Mask / Heal /
//     Curve / Optics are called out in the spec but have no `Tool` case yet;
//     they are rendered as disabled placeholders.
//
// The old behaviour (listing tools in the armed group) is replaced by this
// group-switcher layout so the ControlCard can be simplified to show ONLY the
// sliders of the active group (without embedding the group selector).

import SwiftUI
import MapleCore

struct ToolDock: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 4) {
                // ── Group buttons ────────────────────────────────────────────
                ForEach(ToolGroup.allCases, id: \.self) { group in
                    GroupDockButton(state: state, group: group)
                }

                Divider()
                    .background(ProTokens.border)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)

                // ── Special tool buttons ──────────────────────────────────────
                // Crop — real Tool case.
                SpecialDockButton(
                    state: state,
                    tool: .crop,
                    onPresetsTap: onPresetsTap
                )
                // Presets — real Tool case; tapping also fires the presets sheet.
                SpecialDockButton(
                    state: state,
                    tool: .presets,
                    onPresetsTap: onPresetsTap
                )

                // Mask — disabled placeholder; Tool.mask does not exist yet.
                DisabledDockPlaceholder(symbol: "lasso", label: "Mask")
                // Heal — disabled placeholder; Tool.heal does not exist yet.
                DisabledDockPlaceholder(symbol: "bandage", label: "Heal")
            }
            .padding(.vertical, 10)
        }
        // Width is 64pt (same as before); height grows to fit the new content
        // (4 groups + divider + 2 real special + 2 disabled ≈ 8 rows × 54pt + padding).
        .frame(width: 64, height: min(CGFloat(ToolGroup.allCases.count + 4) * 54 + 40, 520))
        .background(ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 14))
        .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
        .accessibilityIdentifier("editor-tool-dock")
    }
}

// MARK: - GroupDockButton

/// Dock button that ARMS A GROUP — the active indicator follows `armedGroup`,
/// not `armedTool`.
private struct GroupDockButton: View {
    @Bindable var state: EditorState
    let group: ToolGroup

    private var isSelected: Bool { state.armedGroup == group }

    /// Dot shown when any tool in the group has a non-neutral value.
    private var isModified: Bool {
        Tool.tools(in: group).contains { tool in
            guard tool.isWired else { return false }
            let subs = tool.subParams
            if !subs.isEmpty {
                return subs.contains { sub in
                    abs(state.session.model[keyPath: sub.keyPath] - sub.defaultDisplayValue) > 1e-6
                }
            }
            guard ToolValueMapping.displayRange(for: tool) != nil else { return false }
            let v = ToolValueMapping.currentDisplayValue(state.session.model, tool: tool)
            let neutral = ToolValueMapping.defaultDisplayValue(for: tool)
            return abs(v - neutral) > 1e-6
        }
    }

    /// SF Symbols approximations for group icons (no per-group glyph spec yet).
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

                    Image(systemName: symbol)
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(isSelected ? ProTokens.accent : ProTokens.text)

                    if isModified {
                        Circle()
                            .fill(ProTokens.accent)
                            .frame(width: 5, height: 5)
                            .offset(x: 12, y: 12)
                    }
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
        .accessibilityIdentifier("editor-dock-group-\(group.rawValue)")
    }
}

// MARK: - SpecialDockButton

/// Dock button for a special tool (Crop, Presets) that arms the tool directly.
/// Mirrors the old `ToolDockButton` logic.
private struct SpecialDockButton: View {
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
        guard ToolValueMapping.displayRange(for: tool) != nil else { return false }
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

                    ToolGlyph.icon(for: tool, size: 16)
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

// MARK: - DisabledDockPlaceholder

/// Non-interactive placeholder for a dock button whose `Tool` case has not
/// been added to the enum yet.  Shown at reduced opacity so it reads as
/// "coming later" rather than "broken".
private struct DisabledDockPlaceholder: View {
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
        // Not in the a11y tree — disabled tools add no navigable value.
        .accessibilityHidden(true)
    }
}
