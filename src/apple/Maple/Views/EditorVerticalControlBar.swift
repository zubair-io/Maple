// EditorVerticalControlBar.swift — landscape iPad and open-Duo controls.
//
// The compact bottom bar turned on end and docked flush to the trailing edge.
// Left to right: group tabs, the armed group's tools, then the vertical
// ruler. Sub-parameter chips, group accessories and tools without a
// primary field open in a panel beside the bar.

import MapleCore
import MapleUI
import SwiftUI

struct EditorVerticalControlBar: View {
  @Bindable var state: EditorState
  let onPresetsTap: () -> Void
  var showsScope = false
  let maximumHeight: CGFloat
  @State private var contextHeight: CGFloat = 0

  static let preferredHeight: CGFloat = 560
  /// The group tabs never scroll, so shorter windows keep the stacked inspector.
  static let minimumHeight: CGFloat = 360
  private static let contextPanelWidth: CGFloat = 320
  private static let toolColumnWidth: CGFloat = 72
  private static let rulerColumnWidth: CGFloat = 52
  private static let barWidth: CGFloat =
    4 + GroupTabsView.tabThickness + 1 + toolColumnWidth + 1 + rulerColumnWidth + 4
  /// The widest trailing footprint, with the context panel open.
  static let footprintWidth: CGFloat = contextPanelWidth + 12 + barWidth

  /// Landscape iPad and the landscape open Duo, when the editor is tall
  /// enough for the fixed-height tabs. Only the open Duo reaches these
  /// controls with the phone idiom; its portrait editor docks the compact
  /// ruler controls at the bottom instead. The Mac, including the iPad app
  /// running on a Mac, keeps the stacked inspector.
  static func fits(in size: CGSize) -> Bool {
    fits(
      in: size, idiom: MapleShellKind.currentIdiom,
      isiOSAppOnMac: ProcessInfo.processInfo.isiOSAppOnMac)
  }

  static func fits(in size: CGSize, idiom: MapleDeviceIdiom, isiOSAppOnMac: Bool) -> Bool {
    (idiom == .pad || idiom == .phone) && !isiOSAppOnMac && size.width > size.height
      && size.height - 88 >= minimumHeight
  }

  /// The header row and its margin; the bar always starts below it.
  static let headerClearance: CGFloat = 76
  private static let statusSpacing: CGFloat = 12

  /// The bar's top inset from the safe-area top: below the header, and below
  /// any occluded area (the open Duo's clock and battery) or rounded corner
  /// cut-out in the band the bar and its panel cover at the trailing edge.
  static func topClearance(
    occlusions: [CGRect], topTrailingCorner: CGFloat, trailingEdge: CGFloat
  ) -> CGFloat {
    let band = (trailingEdge - footprintWidth)...trailingEdge
    let covered =
      occlusions
      .filter { $0.maxX > band.lowerBound && $0.minX < band.upperBound && $0.maxY > 0 }
      .map(\.maxY)
    let lowest = (covered + [topTrailingCorner]).max() ?? 0
    return max(headerClearance, lowest > 0 ? lowest + statusSpacing : 0)
  }

  /// `topClearance` for this geometry: the vertical bar and the closed
  /// Duo's side group rail both start below the trailing status items. The
  /// Mac never shows either.
  static func top(in geometry: GeometryProxy, statusRegions: [CGRect]) -> CGFloat {
    #if os(iOS)
      return topClearance(
        occlusions: geometry.statusRegions(window: statusRegions),
        topTrailingCorner: geometry.containerCornerInsets.topTrailing.height,
        trailingEdge: geometry.size.width + geometry.safeAreaInsets.trailing)
    #else
      return headerClearance
    #endif
  }

  private var usesToolPanel: Bool { EditorToolPanel.replacesDragBar(state.armedTool) }

  private var contextControls: EditorContextControls {
    EditorContextControls(state: state, showsScope: showsScope, includesDragBar: false)
  }

  private var showsContextPanel: Bool { contextControls.hasContent }

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      if showsContextPanel {
        contextPanel
          .frame(width: Self.contextPanelWidth)
          .transition(.opacity)
      }
      bar
        .frame(height: min(Self.preferredHeight, maximumHeight))
    }
    .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
    .animation(MapleTokens.Motion.groupSwap, value: showsContextPanel)
  }

  private var bar: some View {
    HStack(spacing: 0) {
      GroupTabsView(state: state, axis: .vertical)
      columnDivider
      ToolPillRow(state: state, onPresetsTap: onPresetsTap, axis: .vertical)
        .frame(width: Self.toolColumnWidth)
      columnDivider
      rulerColumn
        .frame(width: Self.rulerColumnWidth)
    }
    .padding(.horizontal, 4)
    .modifier(FloatingSurface(isDocked: true))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-vertical-controls")
  }

  private var columnDivider: some View {
    Rectangle()
      .fill(ProTokens.border)
      .frame(width: 1)
      .padding(.vertical, 16)
  }

  private var rulerColumn: some View {
    VStack(spacing: 4) {
      if usesToolPanel {
        Spacer(minLength: 0)
      } else {
        DragBar(state: state, style: .verticalDragBar)
          .padding(.top, 20)
      }
      Button {
        state.resetToFactoryDefaults()
      } label: {
        MuiIcon(name: "rotate_left", size: .sm)
          .foregroundStyle(ProTokens.textMuted)
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Reset all adjustments")
      .accessibilityIdentifier("editor-vertical-reset-all")
    }
  }

  private var contextPanel: some View {
    // One measured tree stays mounted, so a panel growing past the window
    // starts scrolling without rebuilding the tool's state mid-drag.
    ScrollView(.vertical) {
      contextControls
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) {
          $0.size.height
        } action: {
          contextHeight = $0
        }
    }
    .scrollBounceBehavior(.basedOnSize)
    .frame(height: min(maximumHeight, contextHeight))
    .modifier(FloatingSurface())
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-vertical-context-panel")
  }
}

private struct FloatingSurface: ViewModifier {
  var isDocked = false

  func body(content: Content) -> some View {
    let trailingRadius: CGFloat = isDocked ? 0 : 18
    content.background(
      ProTokens.bg.opacity(ProGlass.opacity),
      in: UnevenRoundedRectangle(
        topLeadingRadius: 18, bottomLeadingRadius: 18,
        bottomTrailingRadius: trailingRadius, topTrailingRadius: trailingRadius))
  }
}
