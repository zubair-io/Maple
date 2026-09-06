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
  @MainActor
  func testSessionMetadataDecodeAndProfileShareTheOriginalFetch() async throws {
    let provider = Provider()
    let original = AssetRef(
      displayName: "photo.CR2", hintExtension: "cr2", stableID: "photo",
      thumbnailProvenance: .smb,
      bytesProvider: { await provider.bytes() })
    let session = EditSession(asset: original)
    let ownedAsset = session.asset
    XCTAssertEqual(ownedAsset.id, original.id)
    XCTAssertEqual(ownedAsset.stableID, original.stableID)
    XCTAssertEqual(ownedAsset.thumbnailProvenance, original.thumbnailProvenance)
    XCTAssertNil(ownedAsset.primaryURL, "Staging must not change sidecar/source routing")

    async let metadata = ownedAsset.bytesProvider!()
    async let decode = ownedAsset.bytesProvider!()
    async let profile = session.renderActor.rawRenderSource.url(for: ownedAsset)
    let (metadataBytes, decodeBytes, profileURL) = try await (metadata, decode, profile)
    XCTAssertEqual(metadataBytes, Data([1, 2, 3, 4]))
    XCTAssertEqual(decodeBytes, metadataBytes)
    XCTAssertEqual(try Data(contentsOf: profileURL), metadataBytes)
    let exportBytes = try await ownedAsset.bytesProvider!()
    XCTAssertEqual(exportBytes, metadataBytes)
    let count = await provider.count
    XCTAssertEqual(count, 1, "Metadata, decode, Auto fitting and export must download once")
  }

  func testFailedRemoteFetchCanRetry() async throws {
    actor RetryingProvider {
      var count = 0
      func bytes() throws -> Data {
        count += 1
        if count == 1 { throw URLError(.networkConnectionLost) }
        return Data([9, 8, 7])
      }
    }
    let provider = RetryingProvider()
    let original = AssetRef(
      displayName: "photo.CR2", hintExtension: "cr2",
      bytesProvider: { try await provider.bytes() })
    let source = RawRenderSource(asset: original)
    do {
      _ = try await source.bytes(for: original)
      XCTFail("First fetch should fail")
    } catch { XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost) }
    let bytes = try await source.bytes(for: original)
    XCTAssertEqual(bytes, Data([9, 8, 7]))
    let count = await provider.count
    XCTAssertEqual(count, 2)
  }

  @MainActor
  func testRemoteRawDecodePreservesOriginalSessionIdentity() async throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let fixture = root.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    let bytes = try Data(contentsOf: fixture)
    let original = AssetRef(displayName: "remote.dng", hintExtension: "dng", stableID: "remote") {
      bytes
    }
    let session = EditSession(asset: original)
    let image = await session.renderActor.sharedDecode(
      asset: session.asset, target: CGSize(width: 64, height: 64), profile: .neutral,
      normalize: { image, asset in
        XCTAssertEqual(asset.id, original.id)
        XCTAssertNil(asset.primaryURL, "A temporary decode path must not become original identity")
        return image
      })
    XCTAssertNotNil(image, "The real native RAW decoder must accept the staged path")
    let snapshot = await session.renderActor.snapshot(forAsset: original)
    XCTAssertNotNil(snapshot.image)
    XCTAssertEqual(session.asset.id, original.id)
    XCTAssertNil(
      session.asset.sidecarURL, "Remote edits must not be written beside the staged file")
  }

}
