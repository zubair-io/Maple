// PreviewPullHeroRectTests.swift — the pull-down hero starts on the photo
// under the finger (#5762, PR #5765 review).
//
// The pull scales the photo area about its centre and offsets it. The
// hero's starting rect is computed from the photo area at rest (measured
// outside that transform), so it must be the rect SwiftUI draws.

import CoreGraphics
import XCTest

@testable import Maple

final class PreviewPullHeroRectTests: XCTestCase {

  /// iPhone portrait: the photo area below the header.
  private let restArea = CGRect(x: 8, y: 60, width: 386, height: 760)

  /// What `.scaleEffect(scale)` (anchored at the area's centre) followed by
  /// `.offset(offset)` does to a rect, written independently of the VM.
  private func drawn(_ rect: CGRect, scale: CGFloat, offset: CGSize) -> CGRect {
    let transform = CGAffineTransform(
      translationX: restArea.midX + offset.width, y: restArea.midY + offset.height
    )
    .scaledBy(x: scale, y: scale)
    .translatedBy(x: -restArea.midX, y: -restArea.midY)
    return rect.applying(transform)
  }

  private func assertHeroMatchesTheDrawnPhoto(
    _ photoInArea: CGRect, translation: CGSize,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    let scale = PreviewViewVM.plainPullScale(translationY: translation.height)
    XCTAssertLessThan(
      scale, 1, "the pull is far enough to shrink the photo", file: file, line: line)
    let onScreen = drawn(
      photoInArea.offsetBy(dx: restArea.minX, dy: restArea.minY), scale: scale,
      offset: translation)
    let hero = PreviewViewVM.pulledRect(
      photoInArea, inRestArea: restArea, scale: scale, offset: translation)
    XCTAssertEqual(hero.minX, onScreen.minX, accuracy: 0.01, file: file, line: line)
    XCTAssertEqual(hero.minY, onScreen.minY, accuracy: 0.01, file: file, line: line)
    XCTAssertEqual(hero.width, onScreen.width, accuracy: 0.01, file: file, line: line)
    XCTAssertEqual(hero.height, onScreen.height, accuracy: 0.01, file: file, line: line)
  }

  func testTheHeroStartsOnTheFitPhotoAsDrawnAfterAScaledAndOffsetPull() {
    assertHeroMatchesTheDrawnPhoto(
      CGRect(x: 0, y: 251.33, width: 386, height: 257.33),
      translation: CGSize(width: 34, height: 180))
  }

  /// A photo not centred in the area (a still a few points off its fit rect)
  /// tells the area's centre, the scale's anchor, from the photo's own.
  func testThePullScalesAboutTheAreasCentreNotThePhotos() {
    assertHeroMatchesTheDrawnPhoto(
      CGRect(x: 40, y: 100, width: 200, height: 133),
      translation: CGSize(width: -20, height: 240))
  }
}
