// LivingSliderRow.swift — Pro Editor Canvas-first (A2, #1555).
//
// Single `LivingSlider` wired to one tool's `AdjustmentModel` field.
// Factored out of `LivingSliderGrid` so `StackedAdjustmentsPanel` can
// reuse the same wiring without duplicating the bipolar / range / gradient
// logic.  `LivingSliderGrid` is unchanged except it references this type
// instead of the private struct it formerly declared locally.
//
// Arms the tool on first drag so the value chip + dock both follow the
// active slider.  Commits an undo snapshot on drag-end.

import SwiftUI
import MapleCore

// MARK: - LivingSliderRow

/// A single `LivingSlider` wired to a tool's `AdjustmentModel` field.
/// Public (internal) so both `LivingSliderGrid` and
/// `StackedAdjustmentsPanel` can import it without a module boundary.
struct LivingSliderRow: View {
    @Bindable var state: EditorState
    let tool: Tool

    private var range: ClosedRange<Double> {
        ToolValueMapping.displayRange(for: tool) ?? (0...100)
    }

    private var defaultValue: Double { ToolValueMapping.defaultDisplayValue(for: tool) }

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

    /// Reads/writes the tool's field directly through the model.  Arms the
    /// tool on first write so the value chip + tool dock follow the drag.
    private var valueBinding: Binding<Double> {
        Binding(
            get: { ToolValueMapping.currentDisplayValue(state.session.model, tool: tool) },
            set: { newVal in
                if state.armedTool != tool { state.arm(tool: tool) }
                ToolValueMapping.apply(newVal, to: &state.session.model, tool: tool)
            }
        )
    }

    var body: some View {
        LivingSlider(
            label: tool.displayName,
            value: valueBinding,
            range: range,
            isBipolar: isBipolar,
            defaultValue: defaultValue,
            gradient: GradientCatalog.stops(for: tool),
            displayValue: displayString,
            onCommit: { state.commit() }
        )
    }
}
