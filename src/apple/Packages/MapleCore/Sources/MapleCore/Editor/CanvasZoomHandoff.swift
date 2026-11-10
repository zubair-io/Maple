// CanvasZoomHandoff.swift — Preview and the editor hand each other the
// canvas (#5764).
//
// The surface that showed the photo hands the next one its zoom, in the
// geometry it was shown in, and the still on screen. The receiver lays the
// photo out in that geometry until it measures its own, so its first frame
// draws the photo where the last surface did; its own viewport then carries
// the zoom on by the continuity rule (docs/zoom.md § Continuity). The hand
// over is a value on the session rather than a shared controller: on iPad
// and Mac the two surfaces replace each other, and a controller held by its
// session would hold that session forever.

import CoreGraphics
import Foundation

public struct CanvasHandoffStill {
  public let image: CGImage
  public let isDisplayPreview: Bool

  public init(image: CGImage, isDisplayPreview: Bool) {
    self.image = image
    self.isDisplayPreview = isDisplayPreview
  }
}

public struct CanvasZoomHandoff {
  let model: CanvasZoomModel
  let context: CanvasZoomContext
  let provisionalImageSize: CGSize?
  public let still: CanvasHandoffStill?
}

extension CanvasZoomController {
  /// The zoom on screen, any gesture settled as a cancel settles it, and
  /// `still`. `nil` before the canvas has measured its viewport.
  public func handoff(still: CanvasHandoffStill?) -> CanvasZoomHandoff? {
    guard viewportPoints != .zero else { return nil }
    recordTrackedPinch()
    let shown = context
    let settled = {
      var model = self.model
      model.pinchCancelled(context: shown)
      model.dragCancelled()
      model.reclampPan(context: shown)
      return model
    }()
    return CanvasZoomHandoff(
      model: settled, context: shown, provisionalImageSize: provisionalImageSize, still: still)
  }

  /// Show the photo as the surface that handed it over did. A layout at a
  /// provisional extent the session has since resolved keeps its rect.
  public func receive(_ handoff: CanvasZoomHandoff) {
    trackedPinch = nil
    model = handoff.model
    let resolvesProvisional = handoff.provisionalImageSize != nil && realImageSize != .zero
    let shown =
      resolvesProvisional
      ? CanvasZoomContext(
        viewportPoints: handoff.context.viewportPoints, nativeImageSize: realImageSize,
        displayScale: handoff.context.displayScale, insets: handoff.context.insets)
      : handoff.context
    if resolvesProvisional { model.imageExtentResolved(from: handoff.context, to: shown) }
    provisionalImageSize = realImageSize == .zero ? handoff.provisionalImageSize : nil
    carriedContext = shown
    guard viewportPoints != .zero else {
      viewportPoints = shown.viewportPoints
      displayScale = shown.displayScale
      viewportInsets = shown.insets
      return
    }
    carryIntoCurrentGeometry()
    pushViewportToSession()
    commitToSession()
  }
}

extension EditSession {
  /// The handoff left for the next surface to show this photo, cleared.
  public func takeCanvasHandoff() -> CanvasZoomHandoff? {
    defer { canvasHandoff = nil }
    return canvasHandoff
  }
}

extension EditorState {
  /// Leave the canvas as shown for Preview, which the editor closes back to.
  public func handOffCanvas() {
    endCropEditing()
    let id = session.asset.id
    let still = seed.image(for: id).map {
      CanvasHandoffStill(image: $0, isDisplayPreview: seed.hasDisplayPreview(for: id))
    }
    session.canvasHandoff = zoom.handoff(still: still)
  }

  /// The session outlives this editor, and Preview draws the applied crop.
  private func endCropEditing() {
    guard session.cropEditingActive else { return }
    session.cropEditingActive = false
    zoom.lockZoomAtFit(false)
  }
}
