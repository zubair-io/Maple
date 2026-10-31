// EditorVerticalControlBar.swift — landscape iPad and open-Duo controls.
//
// The compact bottom bar turned on end and floated on the trailing edge.
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

  /// iPad and the open Duo, in a landscape editor tall enough for the
  /// fixed-height tabs. The Mac, including the iPad app running on a Mac,
  /// keeps the stacked inspector.
  static func fits(in size: CGSize) -> Bool {
    let idiom = MapleShellKind.currentIdiom
    return (idiom == .pad || idiom == .phone) && !ProcessInfo.processInfo.isiOSAppOnMac
      && size.width > size.height && size.height - 88 >= minimumHeight
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
    .modifier(FloatingSurface())
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
  func body(content: Content) -> some View {
    content.background(
      ProTokens.bg.opacity(ProGlass.opacity), in: RoundedRectangle(cornerRadius: 18))
  }
}
