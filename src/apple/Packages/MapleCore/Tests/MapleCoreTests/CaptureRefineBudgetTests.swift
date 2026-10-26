// CaptureRefineBudgetTests.swift — the per-device capture refine budget
// (#5381, #5213 decision 7), pure policy with no GPU or fixture.

import CoreGraphics
import RawPipeline
import XCTest

@testable import MapleCore

#if os(iOS)
  import UIKit
#endif

final class CaptureRefineBudgetTests: XCTestCase {
  private var denoised: AdjustmentModel {
    var model = AdjustmentModel()
    model.chromaPrefilter = 60
    return model
  }

  @MainActor
  func testTheIPhoneClampOnlyAppliesWhileARefinableStageIsEngaged() {
    let target = CGSize(width: 1206, height: 2400)
    XCTAssertEqual(
      CaptureRefineBudget.clampedDecodeTarget(
        model: AdjustmentModel(), isRaw: true, target: target), target)
    XCTAssertEqual(
      CaptureRefineBudget.clampedDecodeTarget(model: denoised, isRaw: false, target: target),
      target)
    let clamped = CaptureRefineBudget.clampedDecodeTarget(
      model: denoised, isRaw: true, target: target)
    #if os(iOS)
      if UIDevice.current.userInterfaceIdiom == .phone {
        XCTAssertEqual(clamped?.height ?? 0, 1536, accuracy: 0.5)
        XCTAssertEqual(clamped?.width ?? 0, 1206 * 1536 / 2400, accuracy: 0.5)
        return
      }
    #endif
    XCTAssertEqual(clamped, target)
  }

  func testABaseIsKeptOnlyForADecodeTheDeviceCanRefine() {
    let edge = CaptureRefineBudget.current.max_long_edge
    XCTAssertTrue(PipelineRenderer.keepsRefineBase(maxLongEdge: edge))
    XCTAssertFalse(PipelineRenderer.keepsRefineBase(maxLongEdge: edge + 1))
  }
}
