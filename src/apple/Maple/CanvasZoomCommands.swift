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
    let textTarget = EditorTextInput.historyTarget
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
      .disabled(router == nil && controller == nil)
      Button("Before / After") { run(.compareToggle) {} }
        .disabled(router == nil)
      Button("Reset Visible Group") { run(.resetGroup) {} }
        .keyboardShortcut("r", modifiers: [.command, .shift])
        .disabled(router == nil)
    }
    CommandGroup(replacing: .undoRedo) {
      Button(removalCanUndo ? "Undo Selection" : "Undo") { history(redo: false) }
        .keyboardShortcut("z", modifiers: .command)
        .disabled(textTarget.hasFocus ? !(textTarget.undoManager?.canUndo ?? false) : !canUndo)
      Button(removalCanRedo ? "Redo Selection" : "Redo") { history(redo: true) }
        .keyboardShortcut("z", modifiers: [.command, .shift])
        .disabled(textTarget.hasFocus ? !(textTarget.undoManager?.canRedo ?? false) : !canRedo)
    }
  }

  private func history(redo: Bool) {
    let textTarget = EditorTextInput.historyTarget
    if textTarget.hasFocus {
      if redo { textTarget.undoManager?.redo() } else { textTarget.undoManager?.undo() }
    } else {
      if let router, router.state.armedTool == .remove {
        let removal = router.state.removal
        if redo ? removal.canRedoSelection : removal.canUndoSelection {
          Task {
            if redo { await removal.redoSelection() } else { await removal.undoSelection() }
          }
          return
        }
      }
      run(redo ? .redo : .undo) {}
    }
  }

  private var removalCanUndo: Bool {
    router?.state.armedTool == .remove && router?.state.removal.canUndoSelection == true
  }

  private var removalCanRedo: Bool {
    router?.state.armedTool == .remove && router?.state.removal.canRedoSelection == true
  }

  private var canUndo: Bool { removalCanUndo || (router?.state.canUndo ?? false) }
  private var canRedo: Bool { removalCanRedo || (router?.state.canRedo ?? false) }

  private func run(_ command: EditorCommandRouter.Command, fallback: () -> Void) {
    if let router {
      router.perform(command, assetID: router.state.session.asset.id)
    } else {
      fallback()
    }
  }
}
