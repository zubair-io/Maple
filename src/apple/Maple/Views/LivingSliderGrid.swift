// LivingSliderGrid.swift — Pro Editor Canvas-first (A2, #1555).
//
// Scrollable grid of `LivingSlider`s for all wired tools in the active
// group.  Each slider drives its tool's `AdjustmentModel` field directly
// through `ToolValueMapping`, arming the tool on touch and committing an
// undo boundary on drag-end.  Replaces the single `DragBar` of the old
// vertical editor — every group tool now has its own gradient track.

import SwiftUI
import MapleCore

struct LivingSliderGrid: View {
    @Bindable var state: EditorState
    @Environment(\.horizontalSizeClass) private var hSizeClass

    /// Two gradient-slider columns on regular (iPad/Mac) so the contained
    /// card fills nicely; a single full-width column on compact (iPhone).
    private var columns: [GridItem] {
        hSizeClass == .regular
            ? [GridItem(.flexible(), spacing: 18), GridItem(.flexible(), spacing: 18)]
            : [GridItem(.flexible())]
    }

    var body: some View {
        let tools = Tool.tools(in: state.armedGroup)
            .filter { $0.isWired && ToolValueMapping.displayRange(for: $0) != nil }

        ScrollView(.vertical, showsIndicators: false) {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 6) {
                ForEach(tools, id: \.self) { tool in
                    LivingSliderRow(state: state, tool: tool)
                        .contentShape(Rectangle())
                        .onTapGesture { state.arm(tool: tool) }
                }
            }
        }
        .frame(maxHeight: 240)
        .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
    }
}

// MARK: - LivingSliderRow

/// A single `LivingSlider` wired to a tool's `AdjustmentModel` field.
/// Arms the tool whenever its slider is dragged so the value chip + tool
/// dock both reflect the active tool.
private struct LivingSliderRow: View {
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
