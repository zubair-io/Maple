import XCTest

@testable import MapleCore

final class PreviewRefinementBackoffTests: XCTestCase {
  private let transient = PreviewFetchOutcome.transientFailure(reason: "http 503")

  func test_transientFailuresBackOff2_4_8_16ThenStayAt16() {
    var backoff = PreviewRefinementBackoff()
    let delays = (0..<7).map { _ in backoff.delay(after: transient) }
    XCTAssertEqual(delays, [2, 4, 8, 16, 16, 16, 16])
  }

  func test_notFoundAndDataStopRetrying() {
    var backoff = PreviewRefinementBackoff()
    XCTAssertNil(backoff.delay(after: .notFound(reason: "http 404")))
    XCTAssertNil(backoff.delay(after: .data(Data([1]))))
    XCTAssertEqual(backoff.failures, 0, "a terminal outcome does not advance the schedule")
  }

  func test_indexingWaitsAtLeastTheServersRetryAfter() {
    var backoff = PreviewRefinementBackoff()
    XCTAssertEqual(backoff.delay(after: .indexing(retryAfter: 5)), 5)
    XCTAssertEqual(
      backoff.delay(after: .indexing(retryAfter: 1)), 4, "never sooner than the schedule")
    XCTAssertEqual(backoff.delay(after: .indexing(retryAfter: nil)), 8)
  }

  func test_indexingRetryAfterIsCapped() {
    var backoff = PreviewRefinementBackoff()
    XCTAssertEqual(backoff.delay(after: .indexing(retryAfter: 3_600)), 60)
  }

  func test_resetRestartsTheSchedule() {
    var backoff = PreviewRefinementBackoff()
    _ = backoff.delay(after: transient)
    _ = backoff.delay(after: transient)
    backoff.reset()
    XCTAssertEqual(backoff.delay(after: transient), 2)
  }

  // MARK: PreviewLoadLog

  func test_logLineCarriesEveryFieldAndHidesFolderNames() {
    let line = PreviewLoadLog.message(
      stage: .refine, event: .fail, assetID: "fs:/srv/photos/Private Trip/IMG_1.DNG",
      sourceKind: "cloud", targetPx: 2048, bytes: nil, elapsedMs: 312,
      reason: "http 202 retry-after 2s")
    XCTAssertTrue(line.hasPrefix("preview stage=refine event=fail asset=path#"))
    XCTAssertTrue(line.contains(".dng source=cloud target_px=2048 elapsed_ms=312"))
    XCTAssertTrue(line.hasSuffix(#"reason="http 202 retry-after 2s""#))
    XCTAssertFalse(line.contains("Private"))
    XCTAssertFalse(line.contains("bytes="))
  }

  func test_redactedIDIsStableAndOpaqueIDsPassThrough() {
    let id = "fs:/srv/photos/a.dng"
    XCTAssertEqual(PreviewLoadLog.redactedAssetID(id), PreviewLoadLog.redactedAssetID(id))
    XCTAssertNotEqual(
      PreviewLoadLog.redactedAssetID(id), PreviewLoadLog.redactedAssetID("fs:/srv/photos/b.dng"))
    XCTAssertEqual(PreviewLoadLog.redactedAssetID("a1b2c3"), "a1b2c3")
  }

  // MARK: ThumbnailSource.hasFixedPreviewTier

  func test_onlyPhotoKitRendersToTheRequestedSize() {
    XCTAssertFalse(ThumbnailSource.photoKit(localID: "x").hasFixedPreviewTier)
    XCTAssertTrue(ThumbnailSource.cloud(absPath: "/a.dng", host: "h").hasFixedPreviewTier)
    let ref = AssetRef(url: URL(fileURLWithPath: "/tmp/a.dng"))
    XCTAssertTrue(ThumbnailSource.local(ref, source: nil).hasFixedPreviewTier)
  }
}
