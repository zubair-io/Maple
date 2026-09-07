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
      let shortCrop = isCompact && geometry.size.height < 500 && state.armedTool == .crop
      let compactPanelHeight = shortCrop ? 96 : min(360, geometry.size.height * 0.40)
      ScrollViewReader { proxy in
        arrangement {
          StackedAdjustmentsPanel(
            state: state, collapsed: $collapsed, showsHeader: !shortCrop
          )
          .frame(width: isCompact ? nil : 320)
          // Keep a usable crop canvas in landscape phone windows. The
          // crop toolbar includes its own Reset and Done actions.
          .frame(
            height: isCompact
              ? compactPanelHeight : nil
          )
          .frame(maxHeight: isCompact ? nil : .infinity)

          ToolDock(
            state: state, onPresetsTap: onPresetsTap,
            onGroupTap: { group in
              collapsed.remove(group)
              scroll(proxy, to: "group-\(group.rawValue)")
            })
        }
        // Report only the fixed controls footprint. The following outer
        // alignment frame fills the editor and must never exclude its canvas.
        .frame(width: isCompact ? nil : 396, height: isCompact ? compactPanelHeight + 80 : nil)
        // The inspector is scrollable for every tool; the dock scrolls too.
        // Wheel events over either must reach that surface, never the canvas.
        .reportsWheelExclusion(in: "editorCanvas", active: true)
        .padding(.top, isCompact ? 0 : 64)
        .padding(12)
        .frame(
          maxWidth: .infinity, maxHeight: .infinity,
          alignment: isCompact ? .bottom : .trailing
        )
        .onChange(of: layout) { _, _ in
          revealArmedTool(proxy)
        }
        .onChange(of: state.armedTool) { _, _ in
          revealArmedTool(proxy)
        }
        .onChange(of: collapsed) { old, new in
          let group = state.armedTool.group
          if old.contains(group) && !new.contains(group) {
            // The section now exists in the scroll view; its target could
            // not be resolved in the update that requested expansion.
            scroll(proxy, to: state.armedTool.rawValue)
          }
        }
      }
    }
  }

  private func revealArmedTool(_ proxy: ScrollViewProxy) {
    if collapsed.remove(state.armedTool.group) == nil {
      scroll(proxy, to: state.armedTool.rawValue)
    }
  }

  private func scroll<ID: Hashable>(_ proxy: ScrollViewProxy, to id: ID) {
    withAnimation(reduceMotion ? nil : MapleTokens.Motion.groupSwap) {
      proxy.scrollTo(id, anchor: .top)
    }
  }
}
