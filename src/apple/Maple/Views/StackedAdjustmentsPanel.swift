// StackedAdjustmentsPanel.swift — shared Apple adjustments inspector (#3252).
// All four groups stay in one scroll view. The host repositions this same
// instance next to the vertical dock or above the horizontal compact dock.

import MapleCore
import SwiftUI

struct StackedAdjustmentsPanel: View {
  @Bindable var state: EditorState
  @Binding var collapsed: Set<ToolGroup>
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: 0) {
      panelHeader
      Divider()
      ScrollView(.vertical) {
        VStack(spacing: 0) {
          if state.armedTool == .crop {
            CropToolbar(state: state)
              .id(Tool.crop.rawValue)
            Divider()
          }
          ForEach(ToolGroup.allCases, id: \.self) { group in
            groupSection(group)
          }
        }
      }
    }
    .background(ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 14))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Adjustments")
    .accessibilityIdentifier("editor-adjustments-panel")
  }

  private var panelHeader: some View {
    HStack {
      Text("ADJUSTMENTS")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ProTokens.textMuted)
      Spacer(minLength: 0)
      Button {
        state.resetToFactoryDefaults()
      } label: {
        Label("Reset All", systemImage: "arrow.counterclockwise")
          .font(.caption)
          .foregroundStyle(ProTokens.textMuted)
          .frame(minHeight: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Reset all adjustments")
      .accessibilityIdentifier("editor-panel-reset-all")
    }
    .padding(.horizontal, 14)
  }

  private func groupSection(_ group: ToolGroup) -> some View {
    let isCollapsed = collapsed.contains(group)
    return VStack(spacing: 0) {
      Button {
        withAnimation(reduceMotion ? nil : MapleTokens.Motion.groupSwap) {
          if isCollapsed { collapsed.remove(group) } else { collapsed.insert(group) }
        }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
            .frame(width: 14)
          Text(group.displayName.uppercased())
          Spacer(minLength: 0)
          let count = modifiedCount(in: group)
          if count > 0 { Text("\(count) edited").foregroundStyle(ProTokens.accent) }
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(ProTokens.textMuted)
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(group.displayName) section")
      .accessibilityValue(isCollapsed ? "Collapsed" : "Expanded")
      .accessibilityIdentifier("editor-panel-section-\(group.rawValue)")
      .id("group-\(group.rawValue)")

      if !isCollapsed { groupSectionBody(group) }
    }
  }

  private func groupSectionBody(_ group: ToolGroup) -> some View {
    let sliderTools = state.visibleTools(in: group)
      .filter {
        $0.isWired && $0 != .bwMix && $0 != .colorGrade
          && ToolValueMapping.displayRange(for: $0) != nil
      }
    return VStack(spacing: 12) {
      if group == .detail && state.armedTool == .mask {
        MaskPanel(state: state).id(Tool.mask.rawValue)
      } else {
        // Temp's scroll target includes the WB actions and provenance above
        // its scalar row. That row uses a secondary ID to avoid duplicate IDs.
        if group == .color { ColorAccessoryRow(state: state).id(Tool.temp.rawValue) }
        ForEach(sliderTools, id: \.self) { tool in
          VStack(spacing: 4) {
            if state.armedTool == tool && state.armedSubParams.count > 1 {
              SubParamRow(state: state)
            }
            LivingSliderRow(state: state, tool: tool)
          }
          .padding(.horizontal, 14)
          .id(tool == .temp ? "temperature-slider" : tool.rawValue)
        }
        if group == .light {
          toolSection(.toneCurve) { ToneCurveSection(state: state) }
        }
        if group == .color {
          if state.session.model.blackWhite == .on {
            toolSection(.bwMix) { BlackWhiteMixSection(state: state) }
          } else {
            toolSection(.hsl) { HSLSection(state: state) }
          }
        }
        if group == .effects {
          toolSection(.colorGrade) { ColorGradingPanel(state: state) }
          toolSection(.filmLook) { FilmSection(state: state) }
        }
        if group == .detail {
          toolSection(.lensCorrections) { LensCorrectionsSection(state: state) }
        }
      }
    }
    .padding(.bottom, 12)
  }

  private func toolSection<Content: View>(
    _ tool: Tool, @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        state.arm(tool: tool)
      } label: {
        Text(tool.displayName)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ProTokens.textMuted)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(tool.displayName)
      .accessibilityIdentifier("editor-panel-tool-\(tool.rawValue)")
      content()
    }
    .padding(.horizontal, 14)
    .id(tool == .temp ? "temperature-slider" : tool.rawValue)
  }

  // MARK: - Modified count helper

  /// How many tools in `group` have a non-neutral value (mirrors the
  /// `isModified` logic in `ToolDockButton`).
  private func modifiedCount(in group: ToolGroup) -> Int {
    Tool.tools(in: group)
      .filter { tool in
        // Film (#2683): counts as modified once a look is chosen,
        // even before Strength (its only sub-param) has moved.
        if tool == .filmLook {
          return !state.session.model.filmLook.isEmpty
        }
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
      .count
  }
}
