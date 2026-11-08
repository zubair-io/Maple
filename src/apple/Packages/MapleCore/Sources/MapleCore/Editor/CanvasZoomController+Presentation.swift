// CanvasZoomController+Presentation.swift — what the canvas actually shows,
// for the photo and every overlay alike (#5743, #5744).
//
// The committed zoom (`displayFrameInPoints`, `panOffset`) is not always what
// is on screen: an iOS pinch draws its live frame as a compositor transform
// over the frozen committed frame, and a settle animation draws its move over
// the settled frame. Both live here, so the canvas leaf and the overlays read
// one transform in the same frame: an overlay placed from the committed values
// would stay put during a pinch and jump at its end.
//
// The crop overlay is drawn at the fit footprint, so zoom is held at fit
// while the Crop tool is armed (`lockZoomAtFit`).

import CoreGraphics
import Foundation

/// The live frame of an iOS pinch: its scale relative to the frozen
/// committed frame, and its pan.
public struct CanvasLivePinch: Equatable, Sendable {
  public let zoom: CGFloat
  public let pan: CGSize
}

/// Everything drawn over the committed zoom. Empty at rest.
public struct CanvasPresentation: Equatable, Sendable {
  public internal(set) var livePinch: CanvasLivePinch?
  public internal(set) var settle: CanvasSettleAnimation?
}

/// The compositor transform of the canvas leaf, which is framed at the
/// committed display frame and centred: a scale about its centre, then the
/// pan from the viewport centre.
public struct CanvasPresentedTransform: Equatable, Sendable {
  public let zoom: CGFloat
  public let pan: CGSize
}

/// The photo as it is on screen: its display frame and its pan from the
/// viewport centre, the same convention as the committed pair.
public struct CanvasPresentedGeometry: Equatable, Sendable {
  public let displayFrame: CGSize
  public let panOffset: CGSize
}

extension CanvasZoomController {
  /// The leaf's transform at `date`: the live pinch, then any settle over it.
  public func presentedTransform(at date: Date) -> CanvasPresentedTransform {
    let live = presentation.livePinch
    let settling = presentation.settle?.transform(at: date) ?? (zoom: 1, offset: .zero)
    let pan = live?.pan ?? panOffset
    return CanvasPresentedTransform(
      zoom: (live?.zoom ?? 1) * settling.zoom,
      pan: CGSize(
        width: pan.width + settling.offset.width, height: pan.height + settling.offset.height))
  }

  /// Where the photo is on screen at `date`. Overlays place themselves from
  /// this, never from the committed frame. `nil` until the frame resolves.
  public func presentedGeometry(at date: Date) -> CanvasPresentedGeometry? {
    guard let frame = displayFrameInPoints else { return nil }
    let shown = presentedTransform(at: date)
    return CanvasPresentedGeometry(
      displayFrame: CGSize(width: frame.width * shown.zoom, height: frame.height * shown.zoom),
      panOffset: shown.pan)
  }

  /// Where the photo comes to rest: the live pinch without the running
  /// settle. For a reader that is not redrawn every frame.
  public var settledGeometry: CanvasPresentedGeometry? {
    presentedGeometry(at: .distantFuture)
  }

  /// True while a settle animation draws over the committed frame, so a
  /// reader redraws every display frame.
  public var isPresentationAnimating: Bool { presentation.settle != nil }

  /// The host draws `animation` over the settled frame; it clears itself
  /// once finished. `nil` stops it.
  public func showSettle(_ animation: CanvasSettleAnimation?) {
    presentation.settle = animation
    guard let animation else { return }
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(CanvasSettleAnimation.duration))
      guard let self, self.presentation.settle == animation else { return }
      self.presentation.settle = nil
    }
  }

  /// Hold zoom at fit with zero pan (the Crop tool, whose overlay is drawn
  /// at the fit footprint), or release it. Locking ends any live gesture
  /// at fit first, so nothing carries the photo off the overlay.
  public func lockZoomAtFit(_ locked: Bool) {
    guard locked != isZoomLocked else { return }
    if locked {
      if model.pinchStartScale != nil { pinchCancelled() }
      dragCancelled()
      resetToFit()
    }
    isZoomLocked = locked
  }

  /// Every reader redraws on a write, so only clear a pinch that is shown.
  func clearLivePinch() {
    guard presentation.livePinch != nil else { return }
    presentation.livePinch = nil
  }
}
