// LivingSliderRow.swift — Pro Editor Canvas-first (A2, #1555).
//
// Single `LivingSlider` wired to one tool's `AdjustmentModel` field.
// Shared by the editor panels, with one range/default/gradient and
// transaction path for every tool.
//
// Arms the tool on first drag so the value chip + dock both follow the
// active slider. Starts the undo transaction before its first value write
// and finishes it on drag/key release or focus loss.

import MapleCore
import SwiftUI

// MARK: - LivingSliderRow

/// A single `LivingSlider` wired to a tool's `AdjustmentModel` field.
/// Shared by the editor's tool and stacked adjustment panels.
struct LivingSliderRow: View {
  @Bindable var state: EditorState
  let tool: Tool

  /// The armed sub-param when it belongs to THIS row's tool (#1876).
  /// Selecting a pill in `SubParamRow` arms a (tool, subParam) pair on
  /// `EditorState`; the slider must then read/write THAT pair's field.
  /// Pre-#1876 this row ignored `armedSubParam` entirely and always
  /// bound through the tool-level `ToolValueMapping` — so all of Split
  /// Tone's Hue/Sat pills (and Vignette Feather, Grain Size/Roughness,
  /// Sharpen Radius/Detail/Masking) silently drove the tool's PRIMARY
  /// field instead of their own.
  private var armedSub: ToolSubParam? {
    guard state.armedTool == tool else { return nil }
    return state.armedSubParam
  }

  private var range: ClosedRange<Double> {
    if let sub = armedSub { return sub.range }
    return ToolValueMapping.displayRange(for: tool) ?? (0...100)
  }

  private var defaultValue: Double {
    armedSub?.defaultDisplayValue ?? ToolValueMapping.defaultDisplayValue(for: tool)
  }

  /// Bipolar when the canonical default sits at (≈) the range midpoint
  /// AND the range extends below it — i.e. a symmetric ±value tool that
  /// wants a centre zero-notch (exposure, contrast, tint…).  One-sided
  /// tools (sharpen 0…150 default 40, temp 2000…12000 default 6500,
  /// noise 0…100) read as unipolar.
  private var isBipolar: Bool {
    let r = range
    let mid = (r.lowerBound + r.upperBound) / 2
    return abs(defaultValue - mid) < (r.upperBound - r.lowerBound) * 0.05
      && r.lowerBound < defaultValue
  }

  private var displayString: String? {
    switch tool {
    case .temp: return String(format: "%.0f K", state.session.model.temperature)
    case .captureSigma: return String(format: "%.2f px", state.session.model.captureSharpeningSigma)
    default: return nil
    }
  }

  /// Reads/writes the armed (tool, subParam) pair's field when a
  /// sub-param pill is selected for this tool, else the tool's primary
  /// field — routed through `EditorState`'s sub-aware value pipe
  /// (#1876), the same already-tested path `DragBar`/`wheelNudge` use.
  /// Arms the tool on first write so the value chip + tool dock follow
  /// the drag.
  private var valueBinding: Binding<Double> {
    Binding(
      get: {
        // `armedDisplayValue` (not the raw model read) so a parked
        // commit-on-release value shows on the thumb while the
        // decode stays untouched (#1153).
        if state.armedTool == tool { return state.armedDisplayValue }
        return ToolValueMapping.currentDisplayValue(state.session.model, tool: tool)
      },
      set: { newVal in
        state.setArmedDisplayValue(newVal)
      }
    )
  }

  var body: some View {
    slider
      .id("\(state.session.asset.id)-\(tool)")
      .accessibilityIdentifier("editor-slider-\(tool.rawValue)")
  }

  var slider: LivingSlider {
    LivingSlider(
      label: armedSub.map { "\(tool.displayName) · \($0.label)" } ?? tool.displayName,
      value: valueBinding,
      range: range,
      isBipolar: isBipolar,
      defaultValue: defaultValue,
      gradient: GradientCatalog.stops(for: tool),
      displayValue: displayString,
      // An unarmed row displays the primary field. Do not restore a
      // remembered secondary parameter underneath its first value write.
      onEditingChanged: { editing in
        if editing {
          state.beginSliderInteraction(
            tool: tool, subParamID: armedSub?.id ?? tool.subParams.first?.id)
        } else {
          state.endGesture()
        }
      }
    )
  }
}
