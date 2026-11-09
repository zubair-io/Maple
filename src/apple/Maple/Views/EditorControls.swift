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
  @Environment(\.statusRegions) private var statusRegions

  var body: some View {
    GeometryReader { geometry in
      if Self.docksCompactBar(size: geometry.size, idiom: MapleShellKind.currentIdiom) {
        compactBar(height: geometry.size.height)
      } else {
        tabletControls(in: geometry)
      }
    }
  }

  /// The portrait open Duo docks the compact ruler controls along the bottom:
  /// tool panels and the ruler above the group tabs and tool pills. Landscape
  /// keeps the trailing vertical bar (#5710).
  static func docksCompactBar(size: CGSize, idiom: MapleDeviceIdiom) -> Bool {
    idiom == .phone && size.height > size.width
  }

  private func compactBar(height: CGFloat) -> some View {
    VStack(spacing: 0) {
      Spacer(minLength: 0)
      IPhoneControlBar(
        state: state, onPresetsTap: onPresetsTap,
        maximumPanelHeight: min(300, height * 0.4), showsScope: showsScope
      )
      .reportsWheelExclusion(in: "editorCanvas", active: true)
      .coversCanvas()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .ignoresSafeArea(edges: .bottom)
  }

  @ViewBuilder private func tabletControls(in geometry: GeometryProxy) -> some View {
    let fitsVerticalBar = EditorVerticalControlBar.fits(in: geometry.size)
    let isBottom =
      layout == .phone
      || (state.armedTool == .crop
        && EditorCropGeometry.stacksControlsAtBottom(
          size: geometry.size, isTablet: EditorCropGeometry.isTabletClass,
          hasFilmstrip: hasFilmstrip, usesVerticalBar: fitsVerticalBar))
    let arrangement =
      isBottom
      ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 12))
    let shortCrop = isBottom && geometry.size.height < 500 && state.armedTool == .crop
    let bottomPanelHeight = shortCrop ? 96 : min(360, geometry.size.height * 0.40)
    let usesVerticalBar = fitsVerticalBar && !isBottom
    if usesVerticalBar {
      let top = EditorVerticalControlBar.top(in: geometry, statusRegions: statusRegions)
      EditorVerticalControlBar(
        state: state, onPresetsTap: onPresetsTap, showsScope: showsScope,
        maximumHeight: max(geometry.size.height - top - 12, 1)
      )
      .reportsWheelExclusion(in: "editorCanvas", active: true)
      .coversCanvas()
      .padding(.top, top)
      .padding([.bottom, .leading], 12)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
      // Docked flush to the screen's trailing edge (#5710), starting below
      // any status items a trailing system rail carries.
      .ignoresSafeArea(.container, edges: .trailing)
    } else {
      stackedControls(
        isBottom: isBottom, arrangement: arrangement, shortCrop: shortCrop,
        bottomPanelHeight: bottomPanelHeight)
    }
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
      .coversCanvas()
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
