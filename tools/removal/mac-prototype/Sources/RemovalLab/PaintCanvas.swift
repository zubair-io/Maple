import AppKit
import SwiftUI

struct PaintCanvas: NSViewRepresentable {
  let image: NSImage
  let strokes: [Stroke]
  let radius: Double
  let mode: String
  let enabled: Bool
  let onStroke: (Stroke) -> Void

  func makeNSView(context: Context) -> PaintView { PaintView() }
  func updateNSView(_ view: PaintView, context: Context) {
    view.image = image
    view.strokes = strokes
    view.radius = radius
    view.mode = mode
    view.enabled = enabled
    view.onStroke = onStroke
    view.needsDisplay = true
  }
}

final class PaintView: NSView {
  var image: NSImage?
  var strokes: [Stroke] = []
  var radius = 0.012
  var mode = "remove"
  var enabled = true
  var onStroke: ((Stroke) -> Void)?
  private var current: [[Double]] = []
  private var cursor = CGPoint(x: 0.5, y: 0.5)
  override var isFlipped: Bool { true }
  override var acceptsFirstResponder: Bool { enabled }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel("Selection canvas")
    setAccessibilityHelp(
      "Press to focus the canvas. Arrow keys move. Space starts or finishes a stroke. Return paints a dot."
    )
  }
  required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

  private var imageRect: CGRect {
    guard let image else { return .zero }
    let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    return CGRect(
      x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width,
      height: size.height)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let image, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let rect = imageRect
    image.draw(
      in: rect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    ctx.saveGState()
    ctx.clip(to: rect)
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    let pending = current.isEmpty ? [] : [Stroke(points: current, radius: radius, mode: mode)]
    for stroke in strokes + pending {
      ctx.setBlendMode(stroke.mode == "erase" ? .clear : .normal)
      ctx.setStrokeColor(
        (stroke.mode == "protect" ? NSColor.systemGreen : NSColor.systemRed).withAlphaComponent(
          0.45
        ).cgColor)
      ctx.setFillColor(
        (stroke.mode == "protect" ? NSColor.systemGreen : NSColor.systemRed).withAlphaComponent(
          0.45
        ).cgColor)
      ctx.setLineWidth(stroke.radius * 2 * max(rect.width, rect.height))
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      let points = stroke.points.map {
        CGPoint(x: rect.minX + $0[0] * rect.width, y: rect.minY + $0[1] * rect.height)
      }
      if points.count == 1, let p = points.first {
        let r = stroke.radius * max(rect.width, rect.height)
        ctx.fillEllipse(in: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2))
      } else if !points.isEmpty {
        ctx.beginPath()
        ctx.addLines(between: points)
        ctx.strokePath()
      }
    }
    ctx.endTransparencyLayer()
    ctx.restoreGState()
    if window?.firstResponder === self {
      let r = radius * max(rect.width, rect.height)
      ctx.setStrokeColor(NSColor.white.cgColor)
      ctx.setLineWidth(1)
      ctx.strokeEllipse(
        in: CGRect(
          x: rect.minX + cursor.x * rect.width - r, y: rect.minY + cursor.y * rect.height - r,
          width: r * 2, height: r * 2))
    }
  }

  private func point(_ event: NSEvent) -> [Double]? {
    let location = convert(event.locationInWindow, from: nil)
    let rect = imageRect
    guard rect.contains(location) else { return nil }
    cursor = CGPoint(
      x: (location.x - rect.minX) / rect.width, y: (location.y - rect.minY) / rect.height)
    return [cursor.x, cursor.y]
  }
  override func mouseDown(with event: NSEvent) {
    guard enabled, let p = point(event) else { return }
    window?.makeFirstResponder(self)
    current = [p]
    needsDisplay = true
  }
  override func mouseDragged(with event: NSEvent) {
    guard enabled, !current.isEmpty, let p = point(event) else { return }
    current.append(p)
    needsDisplay = true
  }
  override func mouseUp(with event: NSEvent) { finish() }
  private func finish() {
    guard !current.isEmpty else { return }
    if enabled { onStroke?(Stroke(points: current, radius: radius, mode: mode)) }
    current = []
    needsDisplay = true
  }
  override func accessibilityPerformPress() -> Bool {
    guard enabled else { return false }
    window?.makeFirstResponder(self)
    needsDisplay = true
    return true
  }
  override func keyDown(with event: NSEvent) {
    guard enabled else { return }
    let step = event.modifierFlags.contains(.shift) ? 0.025 : 0.005
    switch event.keyCode {
    case 123: cursor.x = max(0, cursor.x - step)
    case 124: cursor.x = min(1, cursor.x + step)
    case 125: cursor.y = min(1, cursor.y + step)
    case 126: cursor.y = max(0, cursor.y - step)
    case 49:
      if current.isEmpty { current = [[cursor.x, cursor.y]] } else { finish() }
    case 36:
      current = [[cursor.x, cursor.y]]
      finish()
    case 53: current = []
    default:
      super.keyDown(with: event)
      return
    }
    if !current.isEmpty, [123, 124, 125, 126].contains(event.keyCode) {
      current.append([cursor.x, cursor.y])
    }
    needsDisplay = true
  }
}
