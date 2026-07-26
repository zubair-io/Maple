// FlyoutSliderPanel.swift — Pro Editor Canvas-first (A2).
//
// Variant A ("Card") regular-size layout: a right-side floating glass panel
// showing the ACTIVE GROUP's living-sliders in a single column, headed by the
// group icon + name + a reset affordance.  It sits just left of the ToolDock
// (the group switcher); together they are the "Flyout — dock + slider panel"
// Card design.  On compact (iPhone) the bottom ControlCard is used instead —
// this panel is regular-only (mounted by EditorView).
//
// TEMPORARY: part of the control-variant exploration (see EditorView).  Reuses
// LivingSliderRow + the same sub-param / color-accessory / crop-toolbar rows as
// ControlCard, so the only difference is the container (right-side, single
// column) and the icon header.  Remove with the rest of the exploration.

import SwiftUI
import MapleCore

struct FlyoutSliderPanel: View {
    @Bindable var state: EditorState

    /// Wired, slider-backed tools in the armed group — same filter the
    /// LivingSliderGrid uses, laid out single-column here.
    private var wiredTools: [Tool] {
        state.visibleTools(in: state.armedGroup)
            .filter { $0.isWired && ToolValueMapping.displayRange(for: $0) != nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            if state.armedTool == .crop {
                // Crop toolbar replaces the sliders while Crop is armed.
                CropToolbar(state: state)
            } else if state.armedTool == .hsl {
                // HSL band chips + per-band Hue/Sat/Lum sliders replace the
                // group stack while HSL is armed (#274) — HSL carries no
                // single primary field, so this is its whole control surface.
                // `armedTool` can never be `.hsl` while Black & White is on
                // (#276) — EditorState normalises it to `.bwMix`.
                HSLSection(state: state)
            } else if state.armedTool == .colorGrade {
                // Color Grading's four wheels + luminance/balance sliders
                // replace the sliders while it is armed — same swap as Crop.
                ColorGradingPanel(state: state)
            } else if state.armedTool == .toneCurve {
                // Curve plot + four region sliders replace the sliders while
                // Tone Curve is armed (#367) — it carries eight fields and no
                // single primary one, so this is its whole control surface.
                ToneCurveSection(state: state)
            } else {
                // Sub-param chip row for multi-param tools.
                let subs = state.armedSubParams
                if subs.count > 1 {
                    SubParamRow(state: state)
                }
                // Color-group profile + as-shot accessory.
                if state.armedGroup == .color {
                    ColorAccessoryRow(state: state)
                        .transition(.opacity)
                }
                // Single-column living-slider stack for the active group.
                VStack(spacing: 10) {
                    ForEach(wiredTools, id: \.self) { tool in
                        LivingSliderRow(state: state, tool: tool)
                    }
                }
            }
        }
        .padding(16)
        .frame(width: 300)
        .background(
            ProTokens.bg.opacity(ProGlass.opacity),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
        .accessibilityIdentifier("editor-flyout-panel")
    }

    // MARK: - Header (group icon + name + reset)

    private var header: some View {
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
            .accessibilityIdentifier("editor-flyout-reset-group")
        }
    }

    /// SF Symbols for the group icon — mirrors `ToolDock.GroupDockButton.symbol`.
    private func groupSymbol(_ group: ToolGroup) -> String {
        switch group {
        case .light:   return "sun.max"
        case .color:   return "paintpalette"
        case .effects: return "sparkles"
        case .detail:  return "camera.aperture"
        }
    }

    /// Resets all wired tools in the armed group to their canonical defaults —
    /// a single undo boundary, shared with `ControlCard` and
    /// `MobileControlBar` via `EditorState.resetGroup` so all three cover the
    /// same fields (including HSL's 24 bands, #274).
    private func resetActiveGroup() {
        state.resetGroup(state.armedGroup)
    }
}
