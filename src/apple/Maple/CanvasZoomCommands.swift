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

  var body: some Commands {
    CommandGroup(after: .toolbar) {
      Menu("Zoom") {
        Button("Zoom to Fit") { controller?.resetToFit() }
          .keyboardShortcut("0", modifiers: .command)
        Button("Actual Size (100%)") { controller?.zoomToScale(1) }
          .keyboardShortcut("1", modifiers: .command)
      }
      .disabled(controller == nil)
    }
  }
}
