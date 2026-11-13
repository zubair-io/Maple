// RawRenderSourceCancellationTests — the editor's download of a remote RAW
// recovers when the download is cancelled by something other than the
// editor itself (#5735). Before, the decode returned nothing and the canvas
// stayed blank with nothing left to retry it.

import XCTest

@testable import MapleCore

final class RawRenderSourceCancellationTests: XCTestCase {
  private actor CancelledOnce {
    private let cancellations: Int
    private let bytes: Data
    private(set) var count = 0

    init(cancellations: Int = 1, bytes: Data = Data([1, 2, 3])) {
      self.cancellations = cancellations
      self.bytes = bytes
    }

    func fetch() throws -> Data {
      count += 1
      guard count > cancellations else { throw URLError(.cancelled) }
      return bytes
    }
  }

  private static let syntheticDNG: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }()

  func testDownloadCancelledElsewhereIsRetried() async throws {
    let provider = CancelledOnce()
    let asset = AssetRef(
      displayName: "remote.CR2", hintExtension: "cr2",
      bytesProvider: { try await provider.fetch() })
    let source = RawRenderSource()
    let url = try await source.url(for: asset)
    XCTAssertEqual(try Data(contentsOf: url), Data([1, 2, 3]))
    withExtendedLifetime(source) {}
    let count = await provider.count
    XCTAssertEqual(count, 2)
  }

  func testRepeatedCancellationGivesUpAfterOneRetry() async {
    let provider = CancelledOnce(cancellations: .max)
    let asset = AssetRef(
      displayName: "remote.CR2", hintExtension: "cr2",
      bytesProvider: { try await provider.fetch() })
    do {
      _ = try await RawRenderSource().url(for: asset)
      XCTFail("a download that is always cancelled must fail")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .cancelled)
    }
    let count = await provider.count
    XCTAssertEqual(count, 2, "one retry, never a loop")
  }

  func testCallerCancellationIsNotRetried() async {
    let provider = CancelledOnce()
    let asset = AssetRef(
      displayName: "remote.CR2", hintExtension: "cr2",
      bytesProvider: { try await provider.fetch() })
    let source = RawRenderSource()
    let caller = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await source.url(for: asset)
    }
    do {
      _ = try await caller.value
      XCTFail("a cancelled caller must not get a staged file")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    let count = await provider.count
    XCTAssertEqual(count, 0)
  }

  @MainActor
  func testEditorDecodeRecoversAfterACancelledDownload() async throws {
    let provider = CancelledOnce(bytes: try Data(contentsOf: Self.syntheticDNG))
    let original = AssetRef(displayName: "remote.dng", hintExtension: "dng", stableID: "remote") {
      try await provider.fetch()
    }
    let session = EditSession(asset: original)
    let image = await session.renderActor.sharedDecode(
      asset: session.asset, target: CGSize(width: 64, height: 64), profile: .neutral,
      normalize: { image, _ in image })
    XCTAssertNotNil(image, "the decode must recover instead of leaving the canvas blank")
  }
}
