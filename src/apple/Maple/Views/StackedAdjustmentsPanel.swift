// StackedAdjustmentsPanel.swift — Pro Editor control-variant B (#feat/pro-editor-control-variants).
//
// Full-featured adjustments inspector that surfaces ALL four tool groups in
// one scrollable panel instead of switching groups via the ToolDock + card.
//
// Layout by size class:
//   • Regular (macOS / iPad): right-side frosted glass inspector, ~320pt wide,
//     full height, trailing edge.  Replaces both the ToolDock and the ControlCard.
//   • Compact (iPhone): bottom-anchored glass panel anchored at the bottom,
//     ~65% screen height.  Uses `.mapleBottomSheet` on iOS; falls back to a
//     plain bottom-anchored glass strip on macOS (not reachable in practice
//     since regular is always true on Mac, but the guard keeps it safe).
//
// Structure:
//   ┌──────────────────────────────────────┐
//   │  ADJUSTMENTS          [Reset All ↺]  │  ← panel header
//   ├──────────────────────────────────────┤
//   │  [Crop]  [Presets]                   │  ← special tools row
//   ├──────────────────────────────────────┤
//   │  ▼ LIGHT                             │  ← collapsible section header
//   │    Exposure ─────────────────── +0.0 │
//   │    Highlights ──────────────── +0.0  │
//   │    …                                 │
//   ├──────────────────────────────────────┤
//   │  ▶ COLOR                    2 edited │  ← collapsed section (modified count badge)
//   ├──────────────────────────────────────┤
//   │  ▼ EFFECTS                           │
//   │    …                                 │
//   ├──────────────────────────────────────┤
//   │  ▼ DETAIL                            │
//   │    …                                 │
//   └──────────────────────────────────────┘
//
// Reuses:
//   • `LivingSliderRow` (factored out of LivingSliderGrid) for every slider.
//   • `ColorAccessoryRow` inside the Color section.
//   • `SubParamRow` inside sections where the armed tool has sub-params.
//   • `CropToolbar` surfaces via arm(tool: .crop) — the main canvas still
//     handles the crop overlay; the panel just shows the "Crop" special-tool
//     button.
//   • `ToolGlyph.icon(for:size:)` for the special-tool buttons that map to a
//     real `Tool` case; SF Symbols still cover the disabled placeholders.
//
// Special tools: only `crop` and `presets` exist in the current `Tool` enum.
// The spec also mentions Mask / Heal / Curve / Optics — those cases do NOT
// exist yet and are rendered as disabled placeholder buttons with a brief
// comment to that effect.

import SwiftUI
import MapleCore

// MARK: - StackedAdjustmentsPanel

struct StackedAdjustmentsPanel: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    @Environment(\.horizontalSizeClass) private var hSizeClass

    /// Groups that are collapsed in the section list.  All sections start
    /// expanded.  Uses a `Set` so toggling is O(1).
    @State private var collapsed: Set<ToolGroup> = []

    private var isRegular: Bool { hSizeClass == .regular }

    var body: some View {
        if isRegular {
            regularInspector
        } else {
            compactPanel
        }
    }

    // MARK: - Regular layout (macOS / iPad): right-side inspector

    private var regularInspector: some View {
        VStack(spacing: 0) {
            panelContent
        }
        .frame(width: 320)
        .background(ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 14))
        .padding(.trailing, 12)
        .frame(maxHeight: .infinity)
        .accessibilityIdentifier("editor-adjustments-panel")
    }

    // MARK: - Compact layout (iPhone): bottom-anchored glass panel

    // The `.mapleBottomSheet` modifier is iOS-only (guarded at its definition
    // site in BottomSheet.swift).  On compact we render a plain bottom-anchored
    // glass strip instead; in practice compact + panel is iPhone-only.
    private var compactPanel: some View {
        VStack(spacing: 0) {
            panelContent
        }
        .background(ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .frame(maxHeight: UIMetrics.compactPanelHeight)
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .accessibilityIdentifier("editor-adjustments-panel")
    }

    // MARK: - Shared content

    private var panelContent: some View {
        VStack(spacing: 0) {
            panelHeader
            Divider()
                .background(ProTokens.border)
            specialToolsRow
            Divider()
                .background(ProTokens.border)
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    ForEach(ToolGroup.allCases, id: \.self) { group in
                        groupSection(group)
                    }
                }
            }
        }
    }

    // MARK: - Panel header

    private var panelHeader: some View {
        HStack {
            Text("ADJUSTMENTS")
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(ProTokens.textMuted)
            Spacer(minLength: 0)
            // #2244: was `resetAll()` (revert to the session-open snapshot),
            // which silently kept pre-existing sidecar edits. The epic's
            // contract is factory defaults + As-Shot WB + Auto profile, crop
            // preserved — the same action the pill header's RESET performs.
            Button {
                state.resetToFactoryDefaults()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 10, weight: .regular))
                    Text("Reset All")
                        .font(.system(size: 10, weight: .regular))
                }
                .foregroundStyle(ProTokens.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Reset all adjustments")
            .accessibilityIdentifier("editor-panel-reset-all")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: - Special tools row

    /// Crop and Presets exist as wired `Tool` cases.  Mask / Heal / Curve /
    /// Optics are called out in the spec but have NO corresponding `Tool` case
    /// yet — they are rendered as disabled placeholder buttons.  This comment
    /// intentionally calls them out by name so future contributors know where
    /// to wire them in when the cases land.
    private var specialToolsRow: some View {
        HStack(spacing: 8) {
            // Crop — real Tool case, arms the crop overlay.
            SpecialToolButton(
                icon: .tool(.crop),
                label: "Crop",
                isSelected: state.armedTool == .crop,
                isEnabled: true
            ) {
                state.arm(tool: .crop)
            }
            .accessibilityIdentifier("editor-panel-tool-crop")

            // Presets — real Tool case, opens the presets sheet/popover.
            SpecialToolButton(
                icon: .tool(.presets),
                label: "Presets",
                isSelected: state.armedTool == .presets,
                isEnabled: true
            ) {
                state.arm(tool: .presets)
                onPresetsTap()
            }
            .accessibilityIdentifier("editor-panel-tool-presets")

            // --- Future special tools (no Tool case yet; disabled placeholders) ---
            // Mask — gated on a future `Tool.mask` case (not yet in the enum).
            SpecialToolButton(
                icon: .symbol("lasso"),
                label: "Mask",
                isSelected: false,
                isEnabled: false, // disabled: Tool.mask does not exist yet
                action: {}
            )
            .accessibilityIdentifier("editor-panel-tool-mask")

            // Heal — gated on a future `Tool.heal` case.
            SpecialToolButton(
                icon: .symbol("bandage"),
                label: "Heal",
                isSelected: false,
                isEnabled: false, // disabled: Tool.heal does not exist yet
                action: {}
            )
            .accessibilityIdentifier("editor-panel-tool-heal")

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: - Group section

    @ViewBuilder
    private func groupSection(_ group: ToolGroup) -> some View {
        let isCollapsed = collapsed.contains(group)
        VStack(spacing: 0) {
            groupSectionHeader(group, isCollapsed: isCollapsed)

            if !isCollapsed {
                groupSectionBody(group)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.easeInOut(duration: ProMotion.cardCollapse), value: isCollapsed)
    }

    private func groupSectionHeader(_ group: ToolGroup, isCollapsed: Bool) -> some View {
        Button {
            withAnimation(.easeInOut(duration: ProMotion.cardCollapse)) {
                if isCollapsed {
                    collapsed.remove(group)
                } else {
                    collapsed.insert(group)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(ProTokens.textMuted)
                    .frame(width: 14)

                Text(group.displayName.uppercased())
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(0.6)
                    .foregroundStyle(ProTokens.textMuted)

                Spacer(minLength: 0)

                // Modified-count badge — shows how many tools in this group
                // have been moved from their neutral default.
                let modCount = modifiedCount(in: group)
                if modCount > 0 {
                    Text("\(modCount) edited")
                        .font(.system(size: 9, weight: .regular))
                        .foregroundStyle(ProTokens.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(ProTokens.accent(0x1F), in: Capsule())
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(group.displayName) section, \(isCollapsed ? "collapsed" : "expanded")")
        .accessibilityIdentifier("editor-panel-section-\(group.rawValue)")
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder
    private func groupSectionBody(_ group: ToolGroup) -> some View {
        let sliderTools = Tool.tools(in: group)
            .filter { $0.isWired && ToolValueMapping.displayRange(for: $0) != nil }

        VStack(spacing: 0) {
            // Color-group accessory (profile picker + as-shot button) — shown
            // at the top of the Color section, matching its position in ControlCard.
            if group == .color {
                ColorAccessoryRow(state: state)
                    .padding(.horizontal, 0)
                    .padding(.bottom, 4)
            }

            // Sub-param row — shown when the armed tool (which belongs to this
            // group) has multiple sub-params.
            if group == state.armedGroup {
                let subs = state.armedSubParams
                if subs.count > 1 {
                    SubParamRow(state: state)
                        .padding(.horizontal, 0)
                        .padding(.bottom, 4)
                }
            }

            // Sliders for every wired tool in the group (single column —
            // the panel is itself ~320pt wide so two-column would be cramped).
            VStack(spacing: 4) {
                ForEach(sliderTools, id: \.self) { tool in
                    LivingSliderRow(state: state, tool: tool)
                        .contentShape(Rectangle())
                        .onTapGesture { state.arm(tool: tool) }
                        .padding(.horizontal, 14)
                }
            }
            .padding(.vertical, 6)

            // HSL 8-band panel (#274). It sits inside the Color section
            // rather than in `sliderTools` because HSL carries 24 fields
            // and no single primary one, so it has no `displayRange` and
            // is filtered out of the living-slider stack above.
            if group == .color {
                HSLSection(state: state)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
            }
        }
    }

    // MARK: - Modified count helper

    /// How many tools in `group` have a non-neutral value (mirrors the
    /// `isModified` logic in `ToolDockButton`).
    private func modifiedCount(in group: ToolGroup) -> Int {
        Tool.tools(in: group)
            .filter { tool in
                guard tool.isWired else { return false }
                let subs = tool.subParams
                if !subs.isEmpty {
                    return subs.contains { sub in
                        abs(state.session.model[keyPath: sub.keyPath] - sub.defaultDisplayValue) > 1e-6
                    }
                }
                guard let _ = ToolValueMapping.displayRange(for: tool) else { return false }
                let v = ToolValueMapping.currentDisplayValue(state.session.model, tool: tool)
                let neutral = ToolValueMapping.defaultDisplayValue(for: tool)
                return abs(v - neutral) > 1e-6
            }
            .count
    }
}

// MARK: - UIMetrics

/// Layout constants local to this file.
private enum UIMetrics {
    /// Approximate height of the compact (phone) bottom panel.  65% of a
    /// typical iPhone viewport (~852pt on iPhone 15 Pro).  Caps the panel so
    /// the canvas remains visible above it.
    static let compactPanelHeight: CGFloat = 560
}
