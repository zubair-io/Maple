import MapleCore
import SwiftUI

/// One inspector and one dock keep their identity while their arrangement
/// changes. Session, gesture, selection and zoom state stay with EditorState.
struct EditorControls: View {
  @Bindable var state: EditorState
  let onPresetsTap: () -> Void
  var hasFilmstrip = false
  var showsScope = false
  @Environment(\.mapleLayout) private var layout
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { geometry in
      let fitsVerticalBar =
        geometry.size.width > geometry.size.height
        && geometry.size.height - 88 >= EditorVerticalControlBar.minimumHeight
        && Self.idiomUsesVerticalBar
      let isBottom =
        layout == .phone
        || (MapleShellKind.currentIdiom == .phone && geometry.size.height > geometry.size.width)
        || (state.armedTool == .crop
          && EditorCropGeometry.stacksControlsAtBottom(
            size: geometry.size, isTablet: MapleShellKind.currentIdiom == .pad,
            hasFilmstrip: hasFilmstrip, usesVerticalBar: fitsVerticalBar))
      let arrangement =
        isBottom
        ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 12))
      let shortCrop = isBottom && geometry.size.height < 500 && state.armedTool == .crop
      let bottomPanelHeight = shortCrop ? 96 : min(360, geometry.size.height * 0.40)
      let usesVerticalBar = fitsVerticalBar && !isBottom
      if usesVerticalBar {
        EditorVerticalControlBar(
          state: state, onPresetsTap: onPresetsTap, showsScope: showsScope,
          maximumHeight: max(geometry.size.height - 64 - 24, 1)
        )
        .reportsWheelExclusion(in: "editorCanvas", active: true)
        .padding(.top, 64)
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
      } else {
        stackedControls(
          isBottom: isBottom, arrangement: arrangement, shortCrop: shortCrop,
          bottomPanelHeight: bottomPanelHeight)
      }
    }
  }

  /// iPad and the open Duo. The Mac, including the iPad app running on a
  /// Mac, keeps the stacked inspector.
  private static var idiomUsesVerticalBar: Bool {
    let idiom = MapleShellKind.currentIdiom
    return (idiom == .pad || idiom == .phone) && !ProcessInfo.processInfo.isiOSAppOnMac
  }

  private func stackedControls(
    isBottom: Bool, arrangement: AnyLayout, shortCrop: Bool, bottomPanelHeight: CGFloat
  ) -> some View {
    ScrollViewReader { proxy in
      // The scope owns a row above both trailing controls. Compact layouts
      // keep it inside the inspector scroll area to preserve canvas space.
      VStack(alignment: .trailing, spacing: 8) {
        if showsScope && !isBottom {
          VectorscopeHud(state: state)
        }
        arrangement {
          StackedAdjustmentsPanel(
            state: state, showsHeader: !shortCrop, showsScope: showsScope && isBottom
          )
          .frame(width: isBottom ? nil : 320)
          // Keep a usable crop canvas in short compact windows. The
          // crop toolbar includes its own Reset and Done actions.
          .frame(
            height: isBottom
              ? bottomPanelHeight : nil
          )
          .frame(maxHeight: isBottom ? nil : .infinity)

          ToolDock(
            state: state, onPresetsTap: onPresetsTap,
            horizontal: isBottom,
            onGroupTap: { group in scroll(proxy, to: "group-\(group.rawValue)") })
        }
        .frame(height: isBottom ? bottomPanelHeight + 80 : nil)
      }
      // Report only the fixed controls footprint. The following outer
      // alignment frame fills the editor and must never exclude its canvas.
      .frame(
        width: isBottom ? nil : 396
      )
      // The inspector is scrollable for every tool; the dock scrolls too.
      // Wheel events over either must reach that surface, never the canvas.
      .reportsWheelExclusion(in: "editorCanvas", active: true)
      .padding(.top, isBottom ? 0 : 64)
      .padding(12)
      .frame(
        maxWidth: .infinity, maxHeight: .infinity,
        alignment: isBottom ? .bottom : .trailing
      )
      .onChange(of: layout) { _, _ in
        revealArmedTool(proxy)
      }
      .onChange(of: state.armedTool) { _, _ in
        revealArmedTool(proxy)
      }
    }
  }

  /// A group tap selects its first tool, but should reveal the group heading,
  /// not jump the floating panel down to the first slider. Dedicated tool
  /// panels and other slider selections still reveal their own controls.
  private func revealArmedTool(_ proxy: ScrollViewProxy) {
    let firstTool = Tool.tools(in: state.armedGroup).first
    let target =
      state.armedTool == firstTool
      ? "group-\(state.armedGroup.rawValue)" : state.armedTool.rawValue
    scroll(proxy, to: target)
  }

  private func scroll<ID: Hashable>(_ proxy: ScrollViewProxy, to id: ID) {
    withAnimation(reduceMotion ? nil : MapleTokens.Motion.groupSwap) {
      proxy.scrollTo(id, anchor: .top)
    }
  }
}
