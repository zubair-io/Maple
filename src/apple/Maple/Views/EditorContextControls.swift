// EditorContextControls.swift — the armed tool's contextual controls, shared
// by the compact bottom bar and the landscape vertical bar's side panel.
//
// The container owns the background and the insets; the rows inside it draw
// neither, so stacked rows line up and never paint one surface over another.

import MapleCore
import MapleUI
import SwiftUI

struct EditorContextControls: View {
  @Bindable var state: EditorState
  var showsScope = false
  /// The compact bar puts the ruler under the selected tool's chips; the
  /// vertical bar keeps it in its own column.
  var includesDragBar = true

  static let scopeID = "editor-context-scope"
  static let armedControlID = "editor-context-armed-control"

  var hasContent: Bool {
    showsScope || hasArmedControl || Self.showsColorAccessory(state)
      || Self.showsDemosaicAccessory(state)
  }

  private var hasArmedControl: Bool {
    includesDragBar || EditorToolPanel.replacesDragBar(state.armedTool)
      || Self.showsSubParams(state)
  }

  private static func showsColorAccessory(_ state: EditorState) -> Bool {
    state.armedGroup == .color && state.armedTool != .hsl
  }

  private static func showsDemosaicAccessory(_ state: EditorState) -> Bool {
    state.armedGroup == .detail && (state.armedTool == .sharpen || state.armedTool == .noise)
  }

  private static func showsSubParams(_ state: EditorState) -> Bool {
    state.armedTool != .hsl && state.armedSubParams.count > 1
  }

  var body: some View {
    VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
      if showsScope {
        VectorscopeHud(state: state).frame(maxWidth: .infinity).id(Self.scopeID)
      }
      if Self.showsColorAccessory(state) {
        ColorAccessoryRow(state: state, compactStyle: true)
          .editorContextInsets()
          .transition(.opacity)
      }
      if Self.showsDemosaicAccessory(state) {
        DemosaicAccessoryRow(state: state)
          .editorContextInsets()
          .transition(.opacity)
      }
      if hasArmedControl {
        armedControl.id(Self.armedControlID)
      }
    }
    .padding(.vertical, MuiTokens.spacingSm)
  }

  @ViewBuilder
  private var armedControl: some View {
    if EditorToolPanel.replacesDragBar(state.armedTool) {
      EditorToolPanel(state: state)
    } else {
      VStack(spacing: 6) {
        if Self.showsSubParams(state) {
          SubParamRow(state: state).editorContextInsets()
        }
        if includesDragBar {
          DragBar(state: state)
        }
      }
    }
  }
}

extension View {
  /// The one inset every row in a contextual-controls container shares.
  func editorContextInsets() -> some View {
    padding(.horizontal, MuiTokens.spacingMd)
  }
}
