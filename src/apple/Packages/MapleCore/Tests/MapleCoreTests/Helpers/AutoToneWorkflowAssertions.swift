import Foundation
import XCTest

@testable import MapleCore

@MainActor
enum AutoToneWorkflowAssertions {
  static func apply(_ session: EditSession) async throws {
    let source = try await session.renderActor.rawRenderSource.url(for: session.asset)
    let recommendation = try await AutoAdjustments.compute(forRawAt: source)
    let before = session.model
    let historyCount = session.undoHistory.count
    await EditorState(session: session).applyAuto()
    let applied = session.model
    XCTAssertEqual(session.undoHistory.count, historyCount + 1)
    XCTAssertEqual(session.undoHistory.last?.kind, .auto)
    let values: [(WritableKeyPath<AdjustmentModel, Double>, Double, ClosedRange<Double>)] = [
      (\.exposure, recommendation.exposure, AdjustmentModel.exposureRange),
      (\.contrast, recommendation.contrast, AdjustmentModel.contrastRange),
      (\.highlights, recommendation.highlights, AdjustmentModel.highlightsRange),
      (\.shadows, recommendation.shadows, AdjustmentModel.shadowsRange),
      (\.whites, recommendation.whites, AdjustmentModel.whitesRange),
      (\.blacks, recommendation.blacks, AdjustmentModel.blacksRange),
      (\.temperature, recommendation.temperature, AdjustmentModel.temperatureRange),
      (\.tint, recommendation.tint, AdjustmentModel.tintRange),
    ]
    var unrelated = applied
    for (field, value, range) in values {
      XCTAssertEqual(applied[keyPath: field], min(range.upperBound, max(range.lowerBound, value)))
      unrelated[keyPath: field] = before[keyPath: field]
    }
    XCTAssertEqual(applied.autoExposure, .off)
    XCTAssertEqual(applied.whiteBalancePreset, .auto)
    XCTAssertEqual(applied.wbSource, .auto)
    XCTAssertEqual(applied.wbAlgorithmVersion, autoWhiteBalanceAlgorithmVersion)
    unrelated.autoExposure = before.autoExposure
    unrelated.whiteBalancePreset = before.whiteBalancePreset
    unrelated.wbScaleVersion = before.wbScaleVersion
    unrelated.wbSource = before.wbSource
    unrelated.wbSampleX = before.wbSampleX
    unrelated.wbSampleY = before.wbSampleY
    unrelated.wbAlgorithmVersion = before.wbAlgorithmVersion
    XCTAssertEqual(unrelated, before, "Auto Tone must preserve profile and unrelated controls")
  }
}
