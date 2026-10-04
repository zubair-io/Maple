#if os(macOS)
  import AppKit
  import SwiftUI

  /// The macOS removal brush owns a real pointer surface above the canvas.
  /// #3984: keyboard/assistive painting is preserved research; its live UI
  /// qualification is incomplete. See the draft preservation checkpoint.
  struct RemovalPointerSurface: NSViewRepresentable {
    static let focusNotification = Notification.Name("app.justmaple.removal.focusBrush")
    let focusOwner: AnyObject
    let imageFrame: CGRect
    let inputEnabled: Bool
    let brushDiameter: CGFloat
    let color: NSColor
    let cursor: CGPoint?
    let onCursorChanged: (CGPoint) -> Void
    let onChanged: (CGPoint) -> Void
    let onEnded: () -> Void
    let onCancelled: () -> Void

    func makeNSView(context: Context) -> PointerView {
      let view = PointerView()
      updateNSView(view, context: context)
      view.focusObserver = NotificationCenter.default.addObserver(
        forName: Self.focusNotification, object: focusOwner, queue: .main
      ) { [weak view] _ in
        guard let view, view.inputEnabled else { return }
        view.window?.makeFirstResponder(view)
      }
      return view
    }

    func updateNSView(_ view: PointerView, context: Context) {
      view.onChanged = onChanged
      view.onEnded = onEnded
      view.onCancelled = onCancelled
      view.onCursorChanged = onCursorChanged
      view.imageFrame = imageFrame
      view.brushDiameter = brushDiameter
      view.color = color
      view.cursor = cursor
      view.inputEnabled = inputEnabled
      view.needsDisplay = true
      view.updateAccessiblePosition()
    }

    static func dismantleNSView(_ view: PointerView, coordinator: ()) {
      if let observer = view.focusObserver { NotificationCenter.default.removeObserver(observer) }
    }

    final class PointerView: NSView {
      var onChanged: ((CGPoint) -> Void)?
      var onEnded: (() -> Void)?
      var onCancelled: (() -> Void)?
      var onCursorChanged: ((CGPoint) -> Void)?
      var focusObserver: NSObjectProtocol?
      var imageFrame = CGRect.zero
      var brushDiameter: CGFloat = 0
      var color = NSColor.controlAccentColor
      var cursor: CGPoint?
      var inputEnabled = true {
        didSet {
          if !inputEnabled { stroke = .none }
          setAccessibilityEnabled(inputEnabled)
        }
      }
      private enum Stroke { case none, mouse, keyboard }
      private var stroke = Stroke.none

      override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("Paint selection canvas")
        setAccessibilityIdentifier("removal-paint-canvas")
        setAccessibilityHelp(
          "Arrow keys move the brush; Shift moves faster. Space starts or finishes a stroke. Return paints a point. Escape cancels the stroke."
        )
        setAccessibilityCustomActions([
          NSAccessibilityCustomAction(
            name: "Move brush left", target: self, selector: #selector(left)),
          NSAccessibilityCustomAction(
            name: "Move brush right", target: self, selector: #selector(right)),
          NSAccessibilityCustomAction(name: "Move brush up", target: self, selector: #selector(up)),
          NSAccessibilityCustomAction(
            name: "Move brush down", target: self, selector: #selector(down)),
        ])
      }

      required init?(coder: NSCoder) { super.init(coder: coder) }

      override var isFlipped: Bool { true }
      override var acceptsFirstResponder: Bool { true }
      override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

      override func becomeFirstResponder() -> Bool {
        needsDisplay = true
        return true
      }

      override func resignFirstResponder() -> Bool {
        cancelStroke()
        needsDisplay = true
        return true
      }

      private var keyboardLocation: CGPoint? {
        let visible = bounds.intersection(imageFrame)
        guard !visible.isEmpty else { return nil }
        let point = cursor ?? CGPoint(x: visible.midX, y: visible.midY)
        return CGPoint(
          x: min(visible.maxX, max(visible.minX, point.x)),
          y: min(visible.maxY, max(visible.minY, point.y)))
      }

      private func position(_ point: CGPoint) {
        cursor = point
        onCursorChanged?(point)
        needsDisplay = true
        updateAccessiblePosition()
      }

      func updateAccessiblePosition() {
        guard let point = keyboardLocation else {
          setAccessibilityValue("Photo is outside the visible canvas")
          return
        }
        let x = Int(((point.x - imageFrame.minX) / imageFrame.width * 100).rounded())
        let y = Int(((point.y - imageFrame.minY) / imageFrame.height * 100).rounded())
        setAccessibilityValue(
          "Brush \(x)% across, \(y)% down\(stroke == .keyboard ? "; stroke active" : "")")
      }

      private func cancelStroke() {
        guard stroke != .none else { return }
        stroke = .none
        onCancelled?()
        updateAccessiblePosition()
      }

      private func finishStroke() {
        stroke = .none
        updateAccessiblePosition()
        onEnded?()
      }

      @discardableResult
      private func move(_ delta: CGPoint) -> Bool {
        guard inputEnabled, let point = keyboardLocation else { return false }
        cursor = CGPoint(x: point.x + delta.x, y: point.y + delta.y)
        guard let next = keyboardLocation else { return false }
        position(next)
        if stroke == .keyboard { onChanged?(next) }
        return true
      }

      @objc private func left() -> Bool { move(CGPoint(x: -10, y: 0)) }
      @objc private func right() -> Bool { move(CGPoint(x: 10, y: 0)) }
      @objc private func up() -> Bool { move(CGPoint(x: 0, y: -10)) }
      @objc private func down() -> Bool { move(CGPoint(x: 0, y: 10)) }

      override func accessibilityPerformPress() -> Bool {
        guard inputEnabled, let point = keyboardLocation else { return false }
        window?.makeFirstResponder(self)
        cancelStroke()
        position(point)
        onChanged?(point)
        finishStroke()
        return true
      }

      override func keyDown(with event: NSEvent) {
        guard inputEnabled else { return }
        guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty else {
          super.keyDown(with: event)
          return
        }
        let step: CGFloat = event.modifierFlags.contains(.shift) ? 10 : 1
        switch event.keyCode {
        case 123: move(CGPoint(x: -step, y: 0))
        case 124: move(CGPoint(x: step, y: 0))
        case 125: move(CGPoint(x: 0, y: step))
        case 126: move(CGPoint(x: 0, y: -step))
        case 49:
          guard !event.isARepeat, let point = keyboardLocation else { return }
          if stroke == .keyboard {
            finishStroke()
          } else {
            cancelStroke()
            stroke = .keyboard
            position(point)
            onChanged?(point)
          }
        case 36, 76:
          if !event.isARepeat { _ = accessibilityPerformPress() }
        case 53:
          if stroke == .keyboard { cancelStroke() } else { super.keyDown(with: event) }
        default: super.keyDown(with: event)
        }
      }

      override func draw(_ dirtyRect: NSRect) {
        guard inputEnabled, window?.firstResponder === self, let point = keyboardLocation else {
          return
        }
        color.setStroke()
        let circle = NSBezierPath(
          ovalIn: CGRect(
            x: point.x - brushDiameter / 2, y: point.y - brushDiameter / 2,
            width: brushDiameter, height: brushDiameter))
        circle.lineWidth = 1.5
        circle.stroke()
        let cross = NSBezierPath()
        cross.move(to: CGPoint(x: point.x - 5, y: point.y))
        cross.line(to: CGPoint(x: point.x + 5, y: point.y))
        cross.move(to: CGPoint(x: point.x, y: point.y - 5))
        cross.line(to: CGPoint(x: point.x, y: point.y + 5))
        cross.lineWidth = 1.5
        cross.stroke()
      }

      override func mouseDown(with event: NSEvent) {
        guard inputEnabled else { return }
        window?.makeFirstResponder(self)
        cancelStroke()
        stroke = .mouse
        let point = convert(event.locationInWindow, from: nil)
        position(point)
        onChanged?(point)
      }

      override func mouseDragged(with event: NSEvent) {
        guard inputEnabled, stroke == .mouse else { return }
        let point = convert(event.locationInWindow, from: nil)
        position(point)
        onChanged?(point)
      }

      override func mouseUp(with event: NSEvent) {
        guard inputEnabled, stroke == .mouse else { return }
        let point = convert(event.locationInWindow, from: nil)
        position(point)
        onChanged?(point)
        finishStroke()
      }
    }
  }
#endif
