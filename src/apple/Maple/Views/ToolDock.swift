// ToolDock.swift — the same tools at every MapleLayout (#3252).
// Bottom inspector: horizontal rail. Trailing inspector: vertical rail.
// The entry order, selection, actions and accessibility identifiers agree.

import MapleCore
import SwiftUI

struct ToolDock: View {
  @Bindable var state: EditorState
  var onPresetsTap: () -> Void = {}
  let horizontal: Bool
  var onGroupTap: (ToolGroup) -> Void = { _ in }

  private var arrangement: AnyLayout {
    horizontal ? AnyLayout(HStackLayout(spacing: 4)) : AnyLayout(VStackLayout(spacing: 4))
  }

  var body: some View {
    ScrollView(horizontal ? .horizontal : .vertical, showsIndicators: false) {
      arrangement {
        // ── Group buttons ────────────────────────────────────────────
        ForEach(ToolGroup.allCases, id: \.self) { group in
          GroupDockButton(state: state, group: group, onSelect: { onGroupTap(group) })
        }

        Rectangle()
          .fill(ProTokens.border)
          .frame(width: horizontal ? 1 : 40, height: horizontal ? 40 : 1)
          .padding(4)

        // ── Special tool buttons ──────────────────────────────────────
        // Crop — real Tool case.
        SpecialDockButton(
          state: state,
          tool: .crop,
          onPresetsTap: onPresetsTap
        )
        SpecialDockButton(
          state: state,
          tool: .toneCurve,
          onPresetsTap: onPresetsTap
        )
        SpecialDockButton(
          state: state,
          tool: .filmLook,
          onPresetsTap: onPresetsTap
        )
        // Geometry — real Tool case since #3410. Belongs to the Detail
        // GROUP but, like Curve and Film, has no primary field (seven
        // sliders and no "main" one), so the group's living-slider stack
        // filters it out and the dock is its only route.
        SpecialDockButton(
          state: state,
          tool: .geometry,
          onPresetsTap: onPresetsTap
        )
        // Mask — real Tool case since #3274 (#355). Edited through its
        // own panel, not a slider, so like Curve and Film the dock is one
        // of its two routes; the other is the inspector's Detail section.
        SpecialDockButton(
          state: state,
          tool: .mask,
          onPresetsTap: onPresetsTap
        )
        // Presets — real Tool case; tapping also fires the presets sheet.
        SpecialDockButton(
          state: state,
          tool: .presets,
          onPresetsTap: onPresetsTap
        )

        // Heal — real Tool case since #3409, same two routes as Mask: this
        // dock button and the inspector's Detail section.
        SpecialDockButton(
          state: state,
          tool: .heal,
          onPresetsTap: onPresetsTap
        )
      }
      .padding(horizontal ? .horizontal : .vertical, 10)
    }
    .frame(width: horizontal ? nil : 64, height: horizontal ? 72 : nil)
    .frame(maxWidth: horizontal ? .infinity : nil, maxHeight: horizontal ? nil : 520)
    .background(ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 14))
    .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Editor tools")
    .accessibilityIdentifier("editor-tool-dock")
  }
}

// MARK: - GroupDockButton

/// Dock button that ARMS A GROUP — the active indicator follows `armedGroup`,
/// not `armedTool`.
private struct GroupDockButton: View {
  @Bindable var state: EditorState
  let group: ToolGroup
  let onSelect: () -> Void

  private var isSelected: Bool { state.armedGroup == group }

  /// Dot shown when any tool in the group has a non-neutral value.
  private var isModified: Bool { group.hasEdits(in: state.session.model) }

  /// SF Symbols approximations for group icons (no per-group glyph spec yet).
  var body: some View {
    Button {
      withAnimation(MapleTokens.Motion.groupSwap) { state.arm(group: group) }
      onSelect()
    } label: {
      VStack(spacing: 4) {
        ZStack {
          Circle()
            .fill(
              isSelected
                ? ProTokens.accent(0x28)
                : ProTokens.panel
            )
            .overlay(
              Circle().stroke(
                isSelected ? ProTokens.accent : ProTokens.border,
                lineWidth: 0.5
              )
            )
            .frame(width: 36, height: 36)

          Image(systemName: group.dockSymbol)
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

extension ToolGroup {
  var dockSymbol: String {
    switch self {
    case .light: "sun.max"
    case .color: "paintpalette"
    case .effects: "sparkles"
    case .detail: "camera.aperture"
    }
  }

  func hasEdits(in model: AdjustmentModel) -> Bool {
    Tool.tools(in: self).contains { tool in
      // Film's catalog selection is an edit even at neutral Strength.
      if tool == .filmLook, !model.filmLook.isEmpty { return true }
      guard tool.isWired else { return false }
      let subs = tool.subParams
      if !subs.isEmpty {
        return subs.contains { sub in
          abs(model[keyPath: sub.keyPath] - sub.defaultDisplayValue) > 1e-6
        }
      }
      guard ToolValueMapping.displayRange(for: tool) != nil else { return false }
      let value = ToolValueMapping.currentDisplayValue(model, tool: tool)
      return abs(value - ToolValueMapping.defaultDisplayValue(for: tool)) > 1e-6
    }
  }
}

extension Tool {
  func hasEdits(in model: AdjustmentModel) -> Bool {
    if self == .crop { return !model.crop.isIdentity }
    if self == .filmLook { return !model.filmLook.isEmpty }
    if self == .mask { return !model.localAdjustments.isEmpty }
    if self == .heal { return !model.retouchSpots.isEmpty }
    guard isWired else { return false }
    let subs = subParams
    if !subs.isEmpty {
      return subs.contains { sub in
        abs(model[keyPath: sub.keyPath] - sub.defaultDisplayValue) > 1e-6
      }
    }
    guard ToolValueMapping.displayRange(for: self) != nil else { return false }
    let value = ToolValueMapping.currentDisplayValue(model, tool: self)
    return abs(value - ToolValueMapping.defaultDisplayValue(for: self)) > 1e-6
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

  private var isModified: Bool { tool.hasEdits(in: state.session.model) }

  var body: some View {
    Button {
      state.arm(tool: tool)
      if tool == .presets { onPresetsTap() }
    } label: {
      VStack(spacing: 4) {
        ZStack {
          Circle()
            .fill(
              isSelected
                ? ProTokens.accent(0x28)
                : ProTokens.panel
            )
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
