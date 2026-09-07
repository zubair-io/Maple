import MapleCore
import SwiftUI

/// Pointer/touch and hardware keys share the tap-latches / hold-peeks contract.
struct EditorCompareButton: View {
  @Bindable var state: EditorState
  @Environment(\.editorCommandRouter) private var router
  @State private var pressed = false
  @GestureState private var dragging = false
  @FocusState private var focused: Bool

  var body: some View {
    Image(
      systemName: state.session.showingOriginal
        ? "circle.lefthalf.filled" : "circle.righthalf.filled"
    )
    .font(.system(size: 15)).foregroundStyle(
      state.session.showingOriginal ? ProTokens.accent : ProTokens.textMuted
    )
    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
    .gesture(
      DragGesture(minimumDistance: 0)
        .updating($dragging) { _, active, _ in active = true }
        .onChanged { _ in
          guard !pressed else { return }
          pressed = true
          run(.comparePress)
        }
        .onEnded { _ in
          pressed = false
          run(.compareRelease)
        }
    )
    .focusable().focused($focused).focusEffectDisabled()
    .onKeyPress(keys: [.space, .return], phases: [.down, .repeat, .up]) { press in
      if press.phase == .down { run(.comparePress) }
      if press.phase == .up { run(.compareRelease) }
      return .handled
    }
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(state.session.showingOriginal ? "Show edited" : "Show original")
    .accessibilityValue(state.session.showingOriginal ? "Original" : "Edited")
    .accessibilityHint(
      "Tap to toggle; hold to compare temporarily. B or backslash uses the same action."
    )
    .accessibilityAction { run(.compareToggle) }
    .accessibilityIdentifier("editor-before-after")
    .help("Before / After (B or \\): tap toggles, hold peeks")
    .onChange(of: dragging) { _, active in
      if !active && pressed {
        pressed = false
        router?.cancelCompare()
      }
    }
    .onChange(of: focused) { _, hasFocus in
      if !hasFocus { router?.cancelCompare() }
    }
    .onDisappear { router?.cancelCompare() }
  }

  private func run(_ command: EditorCommandRouter.Command) {
    router?.perform(command, assetID: state.session.asset.id)
  }
}
