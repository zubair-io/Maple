import Foundation
import XCTest

@testable import MapleCore

#if os(macOS)

  final class UnifiedFolderConsumerTests: XCTestCase {
    private struct RequestRecord: Decodable {
      let path: String
      let authorization: String?
      let etag: String?
    }

    func testBrowseAndSidebarConsumeRealEnrichedFolderWire() async throws {
      let fixture = try await UnifiedFolderHTTPFixture.start()
      defer { fixture.stop() }
      let http = client(fixture.url)
      let source = CloudSource(
        server: fixture.url, folderID: "", libraryPath: fixture.album, httpClient: http)
      let listing = try await source.listDir(absPath: fixture.album)
      XCTAssertEqual(
        listing.parent, fixture.library, "parent must be an absolute path, not photos:")
      XCTAssertEqual(listing.dirs.map(\.name), ["Child"])
      XCTAssertEqual(listing.images.first?.size, 14)
      XCTAssertEqual(listing.images.first?.exif?.cameraMake, "Hasselblad")
      let images = try await source.images()
      XCTAssertEqual(images.first?.id, "fs:\(fixture.album)/photo.dng")
      XCTAssertEqual(images.first?.captureDate?.timeIntervalSince1970, 1767323045.123)
      let sidebar = CloudFoldersClient(server: fixture.url, httpClient: http)
      let children = try await sidebar.listDir(absPath: fixture.album)
      XCTAssertEqual(children.dirs, listing.dirs)
      let root = try await sidebar.listDir(absPath: fixture.library)
      XCTAssertNil(root.parent)
      let records = try await requests(fixture.url)
      XCTAssertFalse(records.contains { $0.path.contains("/api/fs/") })
      XCTAssertEqual(
        records.filter { $0.path.contains("/api/folder/photos/My%20Album%20%23%3F") }.count, 3)
      XCTAssertTrue(records.allSatisfy { $0.authorization == "Bearer folder-token" })
    }

    func testFileProviderConsumesAllPagesAndRevalidatesRealETags() async throws {
      let fixture = try await UnifiedFolderHTTPFixture.start()
      defer { fixture.stop() }
      let catalog = RemoteCatalog(http: client(fixture.url), server: fixture.url)
      var contents: [DirContents] = []
      var cursor: String?
      repeat {
        let page = try await catalog.listDir(absolutePath: fixture.album, cursor: cursor, limit: 1)
        XCTAssertEqual(page.parent, fixture.library)
        contents.append(page)
        cursor = page.nextCursor
      } while cursor != nil && contents.count < 10
      XCTAssertNil(cursor, "pagination must terminate")
      XCTAssertEqual(contents.count, 5)
      XCTAssertEqual(contents.flatMap(\.dirs).map(\.name), ["Child"])
      XCTAssertEqual(contents.flatMap(\.images).first?.assetID, fixture.assetID)
      XCTAssertEqual(contents.flatMap(\.sidecars).first?.assetID, fixture.assetID)
      XCTAssertEqual(contents.flatMap(\.files).map(\.name), ["README", "notes.txt"])
      let repeated = try await catalog.listDir(absolutePath: fixture.album, limit: 1)
      XCTAssertEqual(repeated, contents.first)
      let records = try await requests(fixture.url)
      XCTAssertEqual(records.filter { $0.path == "/maple/api/folders" }.count, 1)
      XCTAssertNotNil(records.last?.etag, "second read sends the cached page ETag and decodes 304")
      XCTAssertFalse(records.contains { $0.path.contains("/api/fs/") || $0.path.contains("path=") })
    }

    func testAllReadersRejectUnregisteredPathsWithoutLegacyNetworkFallback() async throws {
      let fixture = try await UnifiedFolderHTTPFixture.start()
      defer { fixture.stop() }
      let http = client(fixture.url)
      let source = CloudSource(server: fixture.url, folderID: "", libraryPath: "", httpClient: http)
      let sidebar = CloudFoldersClient(server: fixture.url, httpClient: http)
      let catalog = RemoteCatalog(http: http, server: fixture.url)
      let outside = "/not-registered/Library"
      do {
        _ = try await source.listDir(absPath: outside)
        XCTFail("Browse must reject")
      } catch { XCTAssertEqual(error as? CloudAddressError, .unregisteredPath(outside)) }
      do {
        _ = try await sidebar.listDir(absPath: outside)
        XCTFail("sidebar must reject")
      } catch { XCTAssertEqual(error as? CloudAddressError, .unregisteredPath(outside)) }
      do {
        _ = try await catalog.listDir(absolutePath: outside)
        XCTFail("File Provider must reject")
      } catch { XCTAssertEqual(error as? CloudAddressError, .unregisteredPath(outside)) }
      let records = try await requests(fixture.url)
      XCTAssertEqual(records.count, 3)
      XCTAssertTrue(records.allSatisfy { $0.path == "/maple/api/folders" })
    }

    func testFileProviderServerUpdateReloadsRootsAndDropsConditionalPages() async throws {
      let first = try await UnifiedFolderHTTPFixture.start()
      defer { first.stop() }
      let second = try await UnifiedFolderHTTPFixture.start()
      defer { second.stop() }
      let catalog = RemoteCatalog(http: client(first.url), server: first.url)
      _ = try await catalog.listDir(absolutePath: first.album, limit: 1)
      let cachedBefore = await catalog._etagCacheCountForTesting
      XCTAssertEqual(cachedBefore, 1)
      await catalog.updateServer(second.url)
      let cachedAfter = await catalog._etagCacheCountForTesting
      XCTAssertEqual(cachedAfter, 0)
      let listing = try await catalog.listDir(absolutePath: second.album, limit: 1)
      XCTAssertEqual(listing.path, second.album)
      let records = try await requests(second.url)
      XCTAssertEqual(records.first?.path, "/maple/api/folders")
      XCTAssertNil(records.last?.etag, "new server must not receive the previous server's ETag")
    }

    func testFileProviderReadsRealUnifiedPreviewAndRevalidatesItsETag() async throws {
      let fixture = try await UnifiedFolderHTTPFixture.start()
      defer { fixture.stop() }
      let catalog = RemoteCatalog(http: client(fixture.url), server: fixture.url)
      let path = "\(fixture.album)/photo.dng"
      let first = try await catalog.getPreview(absPath: path)
      let second = try await catalog.getPreview(absPath: path)
      XCTAssertEqual(first, Data("published-preview".utf8))
      XCTAssertEqual(second, first)
      let records = try await requests(fixture.url)
      XCTAssertEqual(records.filter { $0.path == "/maple/api/folders" }.count, 1)
      let previews = records.filter { $0.path.contains("/api/preview/") }
      XCTAssertEqual(previews.count, 2)
      XCTAssertTrue(
        previews.allSatisfy {
          $0.path
            == "/maple/api/preview/photos/My%20Album%20%23%3F/photo.dng?pv=\(MaplePipelineVersion.value)"
        })
      XCTAssertNotNil(previews.last?.etag)
      XCTAssertTrue(records.allSatisfy { $0.authorization == "Bearer folder-token" })
      XCTAssertFalse(records.contains { $0.path.contains("/api/fs/") })
    }

    private func client(_ url: URL) -> AuthenticatedHTTPClient {
      AuthenticatedHTTPClient(
        server: url, urlSession: URLSession(configuration: .ephemeral),
        tokensProvider: { AuthTokens(access: "folder-token", refresh: "refresh-token") },
        onTokensRefreshed: { _ in }, onSignOut: {})
    }

    private func requests(_ url: URL) async throws -> [RequestRecord] {
      let endpoint = url.deletingLastPathComponent().appendingPathComponent("test/requests")
      // Other File Provider tests register a global URLProtocol; a fresh
      // ephemeral session keeps this probe on the actual loopback transport.
      let (data, _) = try await URLSession(configuration: .ephemeral).data(from: endpoint)
      return try JSONDecoder().decode([RequestRecord].self, from: data)
    }
  }

#endif
