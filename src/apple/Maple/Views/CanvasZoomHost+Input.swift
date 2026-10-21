// CanvasZoomHost+Input.swift — wheel exclusion, UIKit pinch bridge, and macOS
// scroll-wheel catcher extracted from `CanvasZoomHost.swift` (#1099, #2683).

import SwiftUI

#if os(iOS)
  import UIKit
#endif

// MARK: - CanvasWheelExclusionFrame (macOS panel → CanvasZoomHost plumbing)

/// Reports a panel's frame up to `wheelExcludedFrame` (#2683). `nil`
/// (unmounted, or scoped off) clears rather than merges — one panel only.
struct CanvasWheelExclusionKey: PreferenceKey {
  static let defaultValue: CGRect? = nil
  static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) {
    value = nextValue() ?? value
  }
}

/// The `active`-gated decision `reportsWheelExclusion(in:active:)` makes —
/// pulled out for unit testing (`CanvasWheelExclusionTests`, `MapleTests`
/// target). `active: false` always resolves to `nil`, keeping the
/// plain-wheel armed-tool nudge working for every tool but Film (#2683
/// round-2 review item 1: previously excluded unconditionally).
enum CanvasWheelExclusion {
  static func resolvedFrame(panelFrame: CGRect, active: Bool) -> CGRect? {
    active ? panelFrame : nil
  }
}

extension View {
  /// Marks this frame (in `named` coordinate space) a wheel-exclusion
  /// region while `active` — trackpad scroll over it then reaches its own
  /// `ScrollView` instead of the canvas's zoom/pan/wheel-nudge.
  func reportsWheelExclusion(in named: String, active: Bool) -> some View {
    background(
      GeometryReader { proxy in
        Color.clear.preference(
          key: CanvasWheelExclusionKey.self,
          value: CanvasWheelExclusion.resolvedFrame(
            panelFrame: proxy.frame(in: .named(named)), active: active
          )
        )
      }
    )
  }
}

// MARK: - CanvasPinchGesture (iOS)

#if os(iOS)
  /// Bridges a UIKit `UIPinchGestureRecognizer` into SwiftUI so the canvas
  /// zoom can anchor at the EXACT two-finger centroid. `recognizer.scale` is
  /// the cumulative magnification since the gesture began (matching what the
  /// `CanvasZoomController` expects); `recognizer.location(in:)` is the centroid
  /// in the gesture view's local space — the reliable focal point SwiftUI's
  /// `MagnifyGesture` (startAnchor / startLocation) failed to provide.
  struct CanvasPinchGesture: UIGestureRecognizerRepresentable {
    let onChanged: (CGFloat, CGPoint) -> Void
    let onEnded: (CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPinchGestureRecognizer {
      UIPinchGestureRecognizer()
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPinchGestureRecognizer, context: Context) {
      // `context.converter.localLocation` is the centroid in the SwiftUI
      // view's LOCAL space (the viewport) — the space the zoom math uses.
      // `recognizer.location(in: recognizer.view)` is measured against a
      // larger hosting view whose origin sits above the viewport, so it read
      // `y` too large and the focal point landed below the fingers.
      let centroid = context.converter.localLocation
      switch recognizer.state {
      case .began, .changed:
        onChanged(recognizer.scale, centroid)
      case .ended, .cancelled, .failed:
        onEnded(recognizer.scale)
      default:
        break
      }
    }
  }
#endif

// MARK: - ScrollWheelCatcher (macOS)

#if os(macOS)
  /// Invisible NSView that observes scroll-wheel events over its own
  /// frame via a local event monitor. `hitTest` returns nil so clicks and
  /// drags pass straight through to the SwiftUI gestures above it; the
  /// monitor sees every scroll event first and only intercepts those whose
  /// cursor location falls inside this view's bounds in the key window.
  struct ScrollWheelCatcher: NSViewRepresentable {
    struct WheelEvent {
      let deltaX: CGFloat
      let deltaY: CGFloat
      /// True for trackpads (continuous point deltas); false for
      /// line-based mouse wheels.
      let precise: Bool
      /// Cursor location in this view's (flipped, top-left-origin)
      /// coordinates — matches SwiftUI's local space.
      let location: CGPoint
      let commandHeld: Bool
      let shiftHeld: Bool
      let optionHeld: Bool
      /// True during inertial-scroll momentum tails.
      let isMomentum: Bool
    }

    /// Return true to consume the event (it never reaches AppKit),
    /// false to pass it through unchanged.
    let onWheel: @MainActor (WheelEvent) -> Bool

    func makeNSView(context: Context) -> CatcherView {
      let view = CatcherView()
      view.onWheel = onWheel
      return view
    }

    func updateNSView(_ nsView: CatcherView, context: Context) {
      nsView.onWheel = onWheel
    }

    final class CatcherView: NSView {
      var onWheel: (@MainActor (WheelEvent) -> Bool)?
      private var monitor: Any?

      /// Top-left-origin local coordinates, matching SwiftUI.
      override var isFlipped: Bool { true }

      /// Never participate in hit-testing — clicks, drags and pinches
      /// belong to the SwiftUI layer; this view only watches the
      /// event monitor.
      override func hitTest(_ point: NSPoint) -> NSView? { nil }

      override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil {
          installMonitorIfNeeded()
        } else {
          removeMonitorIfNeeded()
        }
      }

      deinit {
        if let monitor {
          NSEvent.removeMonitor(monitor)
        }
      }

      private func installMonitorIfNeeded() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { [weak self] event in
          guard let self,
            let handler = self.onWheel,
            let window = self.window,
            event.window === window
          else { return event }
          let local = self.convert(event.locationInWindow, from: nil)
          guard self.bounds.contains(local) else { return event }
          let wheel = WheelEvent(
            deltaX: event.scrollingDeltaX,
            deltaY: event.scrollingDeltaY,
            precise: event.hasPreciseScrollingDeltas,
            location: local,
            commandHeld: event.modifierFlags.contains(.command),
            shiftHeld: event.modifierFlags.contains(.shift),
            optionHeld: event.modifierFlags.contains(.option),
            isMomentum: event.momentumPhase != []
          )
          // Local monitors fire on the main thread; the handler
          // touches MainActor state (controller / EditorState).
          let consumed = MainActor.assumeIsolated { handler(wheel) }
          return consumed ? nil : event
        }
      }

      private func removeMonitorIfNeeded() {
        if let monitor {
          NSEvent.removeMonitor(monitor)
          self.monitor = nil
        }
      }
    }
  }
#endif
