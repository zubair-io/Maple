// PrecisionDragGesture.swift — a press-and-drag that knows what is
// pressing (#5121).
//
// SwiftUI's `DragGesture` does not say whether a touch is a fingertip or an
// Apple Pencil, and the tone-curve plot needs to: a Pencil tip can address
// points a fingertip cannot tell apart. On iOS the drag is therefore a
// UIKit recognizer that reports each touch's type with its location. The
// Mac has only the pointer, so it keeps `DragGesture`.

import MapleCore
import SwiftUI

/// One sample of a press-and-drag, in the modified view's own space.
struct PrecisionDragSample {
  let location: CGPoint
  let kind: PrecisionInputKind
}

extension View {
  /// A drag that starts at the first contact, with no movement threshold.
  /// `onEnded` receives the release sample, or `nil` when the system took
  /// the gesture away; it can arrive more than once for one drag.
  func precisionDrag(
    onChanged: @escaping (PrecisionDragSample) -> Void,
    onEnded: @escaping (PrecisionDragSample?) -> Void
  ) -> some View {
    #if os(iOS)
      gesture(PrecisionDragGesture(onChanged: onChanged, onEnded: onEnded))
    #else
      modifier(PointerDrag(onChanged: onChanged, onEnded: onEnded))
    #endif
  }
}

#if os(iOS)
  import UIKit
  import UIKit.UIGestureRecognizerSubclass

  extension PrecisionInputKind {
    init(_ type: UITouch.TouchType) {
      switch type {
      case .pencil: self = .pencil
      case .indirectPointer, .indirect: self = .pointer
      case .direct: self = .finger
      @unknown default: self = .finger
      }
    }
  }

  struct PrecisionDragGesture: UIGestureRecognizerRepresentable {
    let onChanged: (PrecisionDragSample) -> Void
    let onEnded: (PrecisionDragSample?) -> Void

    func makeUIGestureRecognizer(context: Context) -> PrecisionDragRecognizer {
      let recognizer = PrecisionDragRecognizer()
      // The curve's points are real views that take focus on touch-down.
      recognizer.cancelsTouchesInView = false
      return recognizer
    }

    func handleUIGestureRecognizerAction(
      _ recognizer: PrecisionDragRecognizer, context: Context
    ) {
      let sample = PrecisionDragSample(
        location: context.converter.localLocation, kind: recognizer.kind)
      switch recognizer.state {
      case .began, .changed: onChanged(sample)
      case .ended: onEnded(sample)
      case .cancelled, .failed: onEnded(nil)
      default: break
      }
    }
  }

  /// Follows the first touch from contact to release and remembers its type.
  final class PrecisionDragRecognizer: UIGestureRecognizer {
    private(set) var kind = PrecisionInputKind.finger
    private weak var tracked: UITouch?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
      guard tracked == nil, let first = touches.first else {
        for touch in touches { ignore(touch, for: event) }
        return
      }
      tracked = first
      kind = PrecisionInputKind(first.type)
      for touch in touches where touch !== first { ignore(touch, for: event) }
      state = .began
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
      if let tracked, touches.contains(tracked) { state = .changed }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
      if let tracked, touches.contains(tracked) { state = .ended }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
      if let tracked, touches.contains(tracked) { state = .cancelled }
    }

    override func reset() {
      super.reset()
      tracked = nil
    }

    /// The Pencil reports positions finer than a point.
    override func location(in view: UIView?) -> CGPoint {
      tracked?.preciseLocation(in: view) ?? super.location(in: view)
    }
  }
#else
  private struct PointerDrag: ViewModifier {
    let onChanged: (PrecisionDragSample) -> Void
    let onEnded: (PrecisionDragSample?) -> Void
    @GestureState private var active = false

    func body(content: Content) -> some View {
      content
        .gesture(
          DragGesture(minimumDistance: 0)
            .updating($active) { _, active, _ in active = true }
            .onChanged { onChanged(PrecisionDragSample(location: $0.location, kind: .pointer)) }
            .onEnded { onEnded(PrecisionDragSample(location: $0.location, kind: .pointer)) }
        )
        .onChange(of: active) { was, now in
          if was && !now { onEnded(nil) }
        }
    }
  }
#endif
