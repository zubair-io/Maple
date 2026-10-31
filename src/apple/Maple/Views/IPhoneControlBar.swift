// IPhoneControlBar.swift — compact S5 controls for the iPhone idiom.
//
// The intentional vertical order is contextual controls, slider, group tabs,
// then tool buttons.
// iPad and macOS continue to use the canvas-first dock/panel controls.

import MapleCore
import MapleUI
import SwiftUI

struct IPhoneControlBar: View {
  @Bindable var state: EditorState
  var onPresetsTap: () -> Void = {}
  var maximumPanelHeight: CGFloat = 300
  var showsGroupTabs = true
  var showsScope = false
  @State private var controlsHeight: CGFloat = 0

  var body: some View {
    VStack(spacing: 0) {
      // One measured content tree stays mounted during rotation. Short tools
      // keep their intrinsic height; only a tall selected tool scrolls. Group
      // tabs and tool pills stay pinned outside this bounded region.
      ScrollViewReader { proxy in
        ScrollView {
          contextualControls
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) {
              $0.size.height
            } action: {
              controlsHeight = $0
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(maximumPanelHeight, controlsHeight))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-iphone-selected-control")
        .onChange(of: controlsHeight) { _, _ in
          if !showsScope { revealSelectedControl(proxy) }
        }
        .onChange(of: maximumPanelHeight) { _, _ in revealSelectedControl(proxy) }
        .onChange(of: state.armedTool) { _, _ in revealSelectedControl(proxy) }
        .onChange(of: showsScope) { _, visible in
          if visible { proxy.scrollTo("editor-phone-scope", anchor: .top) }
        }
      }

      HStack {
        Spacer(minLength: 0)
        Button {
          state.resetToFactoryDefaults()
        } label: {
          Label {
            Text("Reset All")
          } icon: {
            MuiIcon(name: "rotate_left", size: .sm)
          }
          .font(.caption)
          .frame(minHeight: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Reset all adjustments")
        .accessibilityIdentifier("editor-phone-reset-all")
      }
      .padding(.horizontal, 16)

      Divider().background(MapleTokens.border)
      if showsGroupTabs {
        GroupTabsView(state: state)
      }
      ToolPillRow(state: state, onPresetsTap: onPresetsTap)
    }
    .frame(maxWidth: .infinity)
    .background(MapleTokens.bg)
    .safeAreaPadding(.bottom, 6)
    .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-iphone-controls")
  }

  private var contextualControls: some View {
    VStack(spacing: 0) {
      // Share the bounded scroll area so the scope cannot cover the header,
      // pinned group tabs, tool pills, or another adjustment control.
      if showsScope {
        VectorscopeHud(state: state).padding(12).id("editor-phone-scope")
      }
      if state.armedGroup == .color && state.armedTool != .hsl {
        ColorAccessoryRow(state: state, compactStyle: true)
          .transition(.opacity)
      }
      // Demosaic kernel override (#3413) — the compact editor's counterpart
      // to the inspector's Detail row, mirroring how the Colour accessory
      // above appears in both.
      if state.armedGroup == .detail
        && (state.armedTool == .sharpen || state.armedTool == .noise)
      {
        DemosaicAccessoryRow(state: state)
          .transition(.opacity)
      }

      selectedToolControl.id("iphone-armed-control")
    }
  }

  private func revealSelectedControl(_ proxy: ScrollViewProxy) {
    proxy.scrollTo("iphone-armed-control", anchor: .top)
  }

  @ViewBuilder
  private var selectedToolControl: some View {
    if EditorToolPanel.replacesDragBar(state.armedTool) {
      EditorToolPanel(state: state)
    } else {
      VStack(spacing: 0) {
        SubParamRow(state: state)
        DragBar(state: state)
          .padding(.vertical, 6)
      }
    }
  }
}
