import MapleCore
import SwiftUI

private struct CanvasZoomControllerKey: FocusedValueKey {
  typealias Value = CanvasZoomController
}

extension FocusedValues {
  var canvasZoomController: CanvasZoomController? {
    get { self[CanvasZoomControllerKey.self] }
    set { self[CanvasZoomControllerKey.self] = newValue }
  }
}

/// Scene focus keeps commands attached to the visible canvas when a slider
/// or another editor control has keyboard focus, and clears them in Browse.
struct CanvasZoomCommands: Commands {
  @FocusedValue(\.canvasZoomController) private var controller
  @FocusedValue(\.editorCommandRouter) private var router
  @StateObject private var textHistory = EditorTextHistory()

  var body: some Commands {
    let _ = textHistory.revision
    CommandGroup(after: .toolbar) {
      Menu("Zoom") {
        Button("Zoom to Fit") { run(.fit) { controller?.resetToFit() } }
          .keyboardShortcut("0", modifiers: .command)
        Button("Actual Size (100%)") { run(.actualSize) { controller?.zoomToScale(1) } }
          .keyboardShortcut("1", modifiers: .command)
        Button("Zoom In") { run(.zoomIn) { controller?.stepZoomIn() } }
          .keyboardShortcut("=", modifiers: .command)
        Button("Zoom Out") { run(.zoomOut) { controller?.stepZoomOut() } }
          .keyboardShortcut("-", modifiers: .command)
      }
      .disabled(controller == nil)
      Button("Before / After") { run(.compareToggle) {} }
        .disabled(router == nil)
      Button("Reset Visible Group") { run(.resetGroup) {} }
        .keyboardShortcut("r", modifiers: [.command, .shift])
        .disabled(router == nil)
    }
    CommandGroup(replacing: .undoRedo) {
      Button("Undo") { history(redo: false) }
        .keyboardShortcut("z", modifiers: .command)
        .disabled(
          EditorTextInput.hasFocus
            ? !(EditorTextInput.undoManager?.canUndo ?? false) : !(router?.state.canUndo ?? false))
      Button("Redo") { history(redo: true) }
        .keyboardShortcut("z", modifiers: [.command, .shift])
        .disabled(
          EditorTextInput.hasFocus
            ? !(EditorTextInput.undoManager?.canRedo ?? false) : !(router?.state.canRedo ?? false))
    }
  }

  private func history(redo: Bool) {
    if EditorTextInput.hasFocus {
      if redo { EditorTextInput.undoManager?.redo() } else { EditorTextInput.undoManager?.undo() }
    } else {
      run(redo ? .redo : .undo) {}
    }
  }

  private func run(_ command: EditorCommandRouter.Command, fallback: () -> Void) {
    guard !EditorTextInput.hasFocus else { return }
    if let router {
      router.perform(command, assetID: router.state.session.asset.id)
    } else {
      fallback()
    }
  }
}
