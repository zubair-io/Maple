#if os(macOS)
  import AppKit
  import SwiftUI

  /// The macOS removal brush owns a real pointer surface above the canvas.
  struct RemovalPointerSurface: NSViewRepresentable {
    let onChanged: (CGPoint) -> Void
    let onEnded: () -> Void

    func makeNSView(context: Context) -> PointerView {
      let view = PointerView()
      view.onChanged = onChanged
      view.onEnded = onEnded
      return view
    }

    func updateNSView(_ view: PointerView, context: Context) {
      view.onChanged = onChanged
      view.onEnded = onEnded
    }

    final class PointerView: NSView {
      var onChanged: ((CGPoint) -> Void)?
      var onEnded: (() -> Void)?
      private var drawing = false

      override var isFlipped: Bool { true }
      override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

      override func mouseDown(with event: NSEvent) {
        drawing = true
        onChanged?(convert(event.locationInWindow, from: nil))
      }

      override func mouseDragged(with event: NSEvent) {
        guard drawing else { return }
        onChanged?(convert(event.locationInWindow, from: nil))
      }

      override func mouseUp(with event: NSEvent) {
        guard drawing else { return }
        drawing = false
        onChanged?(convert(event.locationInWindow, from: nil))
        onEnded?()
      }
    }
  }
#endif
