import MapleCore
import SwiftUI

/// One inspector and one dock keep their identity while their arrangement
/// changes. Session, gesture, selection and zoom state stay with EditorState.
struct EditorControls: View {
  @Bindable var state: EditorState
  let onPresetsTap: () -> Void
  @Environment(\.mapleLayout) private var layout
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var collapsed: Set<ToolGroup> = []

  private var isCompact: Bool { layout == .phone }
  private var arrangement: AnyLayout {
    isCompact ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 12))
  }

  var body: some View {
    GeometryReader { geometry in
      ScrollViewReader { proxy in
        arrangement {
          StackedAdjustmentsPanel(state: state, collapsed: $collapsed)
            .frame(width: isCompact ? nil : 320)
            .frame(height: isCompact ? min(360, geometry.size.height * 0.40) : nil)
            .frame(maxHeight: isCompact ? nil : .infinity)

          ToolDock(
            state: state, onPresetsTap: onPresetsTap,
            onGroupTap: { group in
              collapsed.remove(group)
              scroll(proxy, to: "group-\(group.rawValue)")
            })
        }
        // The inspector is scrollable for every tool; the dock scrolls too.
        // Wheel events over either must reach that surface, never the canvas.
        .reportsWheelExclusion(in: "editorCanvas", active: true)
        .padding(.top, isCompact ? 0 : 64)
        .padding(12)
        .frame(
          maxWidth: .infinity, maxHeight: .infinity,
          alignment: isCompact ? .bottom : .trailing
        )
        .onChange(of: state.armedTool) { _, tool in
          collapsed.remove(tool.group)
          scroll(proxy, to: tool.rawValue)
        }
      }
    }
  }

  private func scroll<ID: Hashable>(_ proxy: ScrollViewProxy, to id: ID) {
    withAnimation(reduceMotion ? nil : MapleTokens.Motion.groupSwap) {
      proxy.scrollTo(id, anchor: .top)
    }
  }
}
