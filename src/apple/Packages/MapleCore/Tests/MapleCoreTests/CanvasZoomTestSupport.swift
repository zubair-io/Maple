// CanvasZoomTestSupport.swift — shorthand for zoom tests without chrome.
//
// `resetToFit` and `zoomToScale` re-centre in the visible area, so they take
// the context (#5749). Tests that model a canvas with no chrome over it can
// use these: with no insets the centred pan is zero whatever the geometry.

import CoreGraphics

@testable import MapleCore

extension CanvasZoomModel {
  private static let noChrome = CanvasZoomContext(
    viewportPoints: .zero, nativeImageSize: .zero, displayScale: 1)

  mutating func zoomToScale(_ scale: CGFloat) {
    zoomToScale(scale, context: Self.noChrome)
  }

  mutating func resetToFit() {
    resetToFit(context: Self.noChrome)
  }
}
