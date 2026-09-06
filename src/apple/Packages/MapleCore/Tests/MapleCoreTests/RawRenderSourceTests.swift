import Foundation
import XCTest

@testable import MapleCore

final class RawRenderSourceTests: XCTestCase {
  private actor Provider {
    var count = 0
    func bytes() -> Data {
      count += 1
      return Data([1, 2, 3, 4])
    }
  }

  func testRemoteRawIsStagedOnceForConcurrentConsumers() async throws {
    let provider = Provider()
    let asset = AssetRef(
      displayName: "photo.CR2", hintExtension: "cr2",
      bytesProvider: { await provider.bytes() })
    let source = RawRenderSource()
    async let first = source.url(for: asset)
    async let second = source.url(for: asset)
    let urls = try await [first, second]
    XCTAssertEqual(urls[0], urls[1])
    XCTAssertEqual(urls[0].pathExtension, "cr2")
    XCTAssertEqual(try Data(contentsOf: urls[0]), Data([1, 2, 3, 4]))
    let count = await provider.count
    XCTAssertEqual(count, 1)
  }

  func testLocalFileIsNeverCopiedOrRemoved() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "local-render-source")
    defer { try? FileManager.default.removeItem(at: directory) }
    let original = directory.appendingPathComponent("original.cr2")
    try Data([4, 3, 2, 1]).write(to: original)
    let resolved = try await RawRenderSource().url(for: AssetRef(url: original))
    XCTAssertEqual(resolved, original)
    XCTAssertEqual(try Data(contentsOf: original), Data([4, 3, 2, 1]))
  }

  func testRemoteCopyIsRemovedWithItsSessionOwner() async throws {
    let asset = AssetRef(
      displayName: "photo.CR2", hintExtension: "cr2",
      bytesProvider: { Data([1, 2, 3]) })
    var source: RawRenderSource? = RawRenderSource()
    let url = try await source!.url(for: asset)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    source = nil
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }
}
