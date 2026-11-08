// CanvasZoomHost+Settle.swift — the canvas's animations and the visible
// area, extracted from `CanvasZoomHost.swift` (docs/zoom.md § Continuity).
//
// Only finger or pointer motion moves the photo directly. A settle after a
// release, a chrome change, or a deliberate zoom commits at once and animates
// the picture from the frame on screen (`CanvasSettleAnimation`); a pinch,
// drag or wheel that arrives mid-animation holds the frame shown at that
// instant (`holdShownFrame`) and continues from it.

import MapleCore
import SwiftUI

extension CanvasZoomHost {
  // MARK: - Visible area and settling

  /// The canvas area left by the system bars and the floating chrome, as
  /// insets of this host's own frame.
  func visibleInsets(_ geo: GeometryProxy) -> CanvasViewportInsets {
    CanvasViewportInsets.covering(
      viewport: geo.frame(in: .global), safeArea: safeAreaFrame, frames: coverFrames)
  }

  /// The compositor zoom of a live iOS pinch; 1 elsewhere.
  var liveGestureZoom: CGFloat {
    #if os(iOS)
      gestureZoom
    #else
      1
    #endif
  }

  var isPinching: Bool {
    #if os(iOS)
      pinchActive
    #else
      controller.model.pinchStartScale != nil
    #endif
  }

  /// The model has just settled somewhere other than what `shown` drew:
  /// animate from `shown`, so only the fingers ever move the photo directly.
  func beginSettle(from shown: CanvasShownFrame) {
    startSettle(CanvasSettleAnimation(from: shown, to: controller.restingFrame, start: Date()))
  }

  func startSettle(_ animation: CanvasSettleAnimation?) {
    settle = animation
    guard let animation else { return }
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(CanvasSettleAnimation.duration))
      if settle == animation { settle = nil }
    }
  }

  /// The model moved somewhere new while a settle was drawing (a zoom
  /// command, a wheel pan): head there from what is on screen.
  func retargetSettle(to settled: CanvasShownFrame) {
    guard let running = settle, running.to != settled else { return }
    startSettle(CanvasSettleAnimation(from: running.shown(at: Date()), to: settled, start: Date()))
  }

  /// A pinch or pan takes over mid-settle: it starts from what is on
  /// screen, not from where the settle was heading (#5742).
  func interruptSettle() {
    guard let running = settle else { return }
    settle = nil
    let now = Date()
    guard !running.isFinished(at: now) else { return }
    controller.holdShownFrame(running.shown(at: now))
  }

  /// A deliberate zoom (a command, double-tap, the badge, the wheel landing
  /// on fit) animates from what is on screen — mid-animation from the frame
  /// it shows — to the new resting frame (#5741, #5742). The fingers own a
  /// live pinch, which continues from the command's result instead.
  func animateCommand(_ move: CanvasCommandedMove?) {
    guard let move else { return }
    guard !isPinching else {
      refreshLivePinch()
      return
    }
    guard canvasReady else { return }
    let now = Date()
    let from = settle.map { $0.shown(at: now) } ?? move.from
    startSettle(CanvasSettleAnimation(from: from, to: controller.restingFrame, start: now))
  }

  /// The model moved under a live iOS pinch (a command, a geometry change):
  /// redraw the live frame it now continues from, before the next finger
  /// frame arrives.
  func refreshLivePinch() {
    #if os(iOS)
      guard pinchActive else { return }
      let transform = controller.gestureTransform(
        magnification: pinchLastMag, liveCentroid: pinchLastCentroid)
      gestureZoom = transform.zoom
      gestureCommittedPan = transform.committedPan
      liveZoomScale = controller.effectivePixelScale * transform.zoom
    #endif
  }

  /// A bar shown or hidden, the inspector resized: re-resolve the visible
  /// area and animate any move it causes from what is on screen. Deferred
  /// while a pinch is live (#5736); not animated before the photo is drawn.
  func insetsChanged(_ insets: CanvasViewportInsets) {
    guard !isPinching else {
      pendingInsets = insets
      return
    }
    pendingInsets = nil
    let shown = settle?.shown(at: Date()) ?? controller.restingFrame
    settle = nil
    controller.viewportInsetsChanged(insets)
    if canvasReady { beginSettle(from: shown) }
  }

  /// Release: commit, apply any chrome change held during the pinch, then
  /// animate from the last frame shown to the settled zoom.
  func settleRelease(from shown: CanvasShownFrame, commit: () -> Void) {
    commit()
    if let pending = pendingInsets {
      pendingInsets = nil
      controller.viewportInsetsChanged(pending)
    }
    beginSettle(from: shown)
  }
}
