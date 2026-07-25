// LivingSliderGrid.swift — Pro Editor Canvas-first (A2, #1555).
//
// Scrollable grid of `LivingSlider`s for all wired tools in the active
// group.  Each slider drives its tool's `AdjustmentModel` field directly
// through `ToolValueMapping`, arming the tool on touch and committing an
// undo boundary on drag-end.  Replaces the single `DragBar` of the old
// vertical editor — every group tool now has its own gradient track.
//
// `LivingSliderRow` (the per-tool wiring) lives in `LivingSliderRow.swift`
// so `StackedAdjustmentsPanel` can reuse it without duplication.

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
        let tools = state.visibleTools(in: state.armedGroup)
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
