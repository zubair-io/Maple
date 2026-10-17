// GeneratedSearchCollectionsCacheFileProviderTests.swift
//
// File Provider extensions run in their own process with their own caches
// container, so a delete or folder trash from Files or Finder records a
// deletion marker in the App Group container (#4612). `ForYouCache` drains
// those markers through `forgetAsset` / `forgetFolder` before rendering or
// committing a refresh, then clears the applied records.

import FileProvider
import XCTest

@testable import MapleCloudKit
@testable import MapleCore

extension GeneratedSearchCollectionsCacheTests {
  func testFileProviderAssetDeleteRecordsAppliesAndClearsBeforeFirstRender() async throws {
    let deletionsDir = directory.appendingPathComponent("app-group-deletions", isDirectory: true)
    let assetID = "650a1b2c3d4e5f6071829304"
    let keepID = "650a1b2c3d4e5f6071829305"
    let host = FPCoreTestSupport.server.cacheHostKey
    let cache = ForYouCache(directory: directory, deletionsDirectory: deletionsDir)
    await cache.write(
      ForYouSnapshot(
        collections: [
          GeneratedSearchCard(
            id: "a", theme: "t", title: "a", result_count: 1, generated_for: CachedCardsStub.day),
          GeneratedSearchCard(
            id: "b", theme: "t", title: "b", result_count: 1, generated_for: CachedCardsStub.day),
        ],
        firstPages: [
          "a": GeneratedSearchAssetPage(
            results: [Self.serverAsset(objectID: assetID, absPath: "/p/a.dng")],
            total: 1, isSnapshot: true),
          "b": GeneratedSearchAssetPage(
            results: [Self.serverAsset(objectID: keepID, absPath: "/p/b.dng")],
            total: 1, isSnapshot: true),
        ],
        savedAt: Date()),
      libraryID: Self.library,
      host: host)

    StubURLProtocol.reset()
    let catalog = FPCoreTestSupport.makeCatalog { _ in (204, Data(), [:]) }
    let core = FPCoreTestSupport.makeCore(
      catalog: catalog, forYouDeletionsDirectory: deletionsDir, test: self)
    let deleteErr = await Self.deleteFileProviderItem(
      core: core, identifier: FileProviderIdentifier.asset(assetID))
    XCTAssertNil(deleteErr)
    XCTAssertEqual(
      Self.markerFiles(in: deletionsDir).count, 1,
      "successful File Provider asset delete writes a marker in the App Group directory")

    let stub = CachedCardsStub(covers: ["a": nil, "b": keepID])
    stub.hold()
    let vm = makeVMForHost(stub, cache: cache, host: host)
    let load = Task { await vm.load() }
    try await waitUntil { !vm.collections.isEmpty }

    XCTAssertNil(
      vm.covers["a"], "the photo deleted via File Provider must not render as a cached cover")
    XCTAssertEqual(vm.covers["b"]?.abs_path, "/p/b.dng")
    XCTAssertTrue(
      Self.markerFiles(in: deletionsDir).isEmpty,
      "applied File Provider deletion markers are cleared")

    stub.release()
    await load.value
  }

  func testFileProviderFolderTrashRecordsAppliesAndClearsBeforeFirstRender() async throws {
    let deletionsDir = directory.appendingPathComponent("app-group-deletions", isDirectory: true)
    let host = FPCoreTestSupport.server.cacheHostKey
    let cache = ForYouCache(directory: directory, deletionsDirectory: deletionsDir)
    await cache.write(
      ForYouSnapshot(
        collections: [
          GeneratedSearchCard(
            id: "a", theme: "t", title: "a", result_count: 1, generated_for: CachedCardsStub.day),
          GeneratedSearchCard(
            id: "b", theme: "t", title: "b", result_count: 1, generated_for: CachedCardsStub.day),
        ],
        firstPages: [
          "a": GeneratedSearchAssetPage(
            results: [
              Self.serverAsset(objectID: "650a1b2c3d4e5f6071829301", absPath: "/p/2024/Trip/a.dng")
            ],
            total: 1, isSnapshot: true),
          "b": GeneratedSearchAssetPage(
            results: [
              Self.serverAsset(objectID: "650a1b2c3d4e5f6071829302", absPath: "/p/2024/Home/b.dng")
            ],
            total: 1, isSnapshot: true),
        ],
        savedAt: Date()),
      libraryID: Self.library,
      host: host)

    StubURLProtocol.reset()
    let catalog = FPCoreTestSupport.makeCatalog { _ in
      let body = #"{"total": 1, "succeeded": 1, "failed": 0, "items": []}"#
      return (200, Data(body.utf8), ["Content-Type": "application/json"])
    }
    let roots = [LibraryRoot(id: "lib", path: "/p", label: "Photos", fileCount: 2)]
    let core = FPCoreTestSupport.makeCore(
      catalog: catalog, roots: roots, forYouDeletionsDirectory: deletionsDir, test: self)
    let deleteErr = await Self.deleteFileProviderItem(
      core: core,
      identifier: FileProviderIdentifier.folder(folderID: "lib", relativePath: "2024/Trip"))
    XCTAssertNil(deleteErr)
    XCTAssertEqual(Self.markerFiles(in: deletionsDir).count, 1)

    let stub = CachedCardsStub(covers: ["a": nil, "b": "old-b"])
    stub.hold()
    let vm = makeVMForHost(stub, cache: cache, host: host)
    let load = Task { await vm.load() }
    try await waitUntil { !vm.collections.isEmpty }

    XCTAssertNil(vm.covers["a"], "trashed folder's cover is dropped before the first render")
    XCTAssertEqual(vm.covers["b"]?.abs_path, "/p/2024/Home/b.dng")
    XCTAssertTrue(Self.markerFiles(in: deletionsDir).isEmpty)

    stub.release()
    await load.value
  }

  func testFileProviderIndexedFileDeleteAndInFlightRefreshRejection() async throws {
    let deletionsDir = directory.appendingPathComponent("app-group-deletions", isDirectory: true)
    let host = FPCoreTestSupport.server.cacheHostKey
    let cache = ForYouCache(directory: directory, deletionsDirectory: deletionsDir)
    await cache.write(
      Self.snapshot(["a": "old-a", "b": "keep-b"]), libraryID: Self.library, host: host)

    StubURLProtocol.reset()
    let catalog = FPCoreTestSupport.makeCatalog { req in
      if req.url?.path == "/api/folders/lib/file" {
        let body = #"{"error":"indexed","asset_id":"650a1b2c3d4e5f6071829309"}"#
        return (409, Data(body.utf8), ["Content-Type": "application/json"])
      }
      return (204, Data(), [:])
    }
    let roots = [LibraryRoot(id: "lib", path: "/p", label: "Photos", fileCount: 2)]
    let core = FPCoreTestSupport.makeCore(
      catalog: catalog, roots: roots, forYouDeletionsDirectory: deletionsDir, test: self)
    let deleteErr = await Self.deleteFileProviderItem(
      core: core,
      identifier: FileProviderIdentifier.file(folderID: "lib", relativePath: "old-a.dng"))
    XCTAssertNil(deleteErr)
    XCTAssertEqual(Self.markerFiles(in: deletionsDir).count, 1)

    let warmer = CoverWarmerProbe()
    warmer.hold()
    let stub = CachedCardsStub(covers: ["a": "new-a", "b": "keep-b"])
    let vm = makeVMForHost(stub, cache: cache, host: host, warmer: warmer)

    let load = Task { await vm.load() }
    try await waitUntil { warmer.warmed == ["new-a"] }
    XCTAssertNil(vm.covers["a"], "indexed-file fallback delete cleared old-a before first render")
    ForYouCache.recordDeletedAsset(
      host: host, assetID: "new-a", absPath: "/p/new-a.dng", directory: deletionsDir)
    stub.covers = ["a": nil, "b": "keep-b"]
    warmer.release()
    await load.value

    XCTAssertNil(
      vm.covers["a"],
      "a File Provider deletion recorded mid-refresh bumps the epoch and rejects the stale commit")
    XCTAssertEqual(vm.covers["b"]?.id, "keep-b")
    XCTAssertTrue(Self.markerFiles(in: deletionsDir).isEmpty)
  }

  func testPreUpgradeVersion2SnapshotWithoutUnderscoreIDIsIgnored() async throws {
    XCTAssertEqual(ForYouSnapshot.currentVersion, 3)
    let cache = ForYouCache(directory: directory)
    await cache.write(
      Self.snapshot(["a": "fs:/p/a.dng"]), libraryID: Self.library, host: Self.host)

    let hostDirs = try FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: nil)
    let snapshotFiles = try FileManager.default.contentsOfDirectory(
      at: XCTUnwrap(hostDirs.first), includingPropertiesForKeys: nil)
    let file = try XCTUnwrap(snapshotFiles.first { $0.pathExtension == "json" })
    var root =
      try XCTUnwrap(
        JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    root["version"] = 2
    try JSONSerialization.data(withJSONObject: root).write(to: file, options: .atomic)

    let readAfterDowngrade = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertNil(
      readAfterDowngrade,
      "pre-upgrade version-2 snapshot lacking _id is rejected rather than surviving ID-only deletes"
    )
  }

  func testFileProviderWindowsFolderTrashNormalizesSlashesAndClearsCover() async throws {
    let deletionsDir = directory.appendingPathComponent("app-group-deletions", isDirectory: true)
    let host = FPCoreTestSupport.server.cacheHostKey
    let cache = ForYouCache(directory: directory, deletionsDirectory: deletionsDir)
    let tripAsset = SearchAsset(
      id: #"fs:C:\photos\2024\Trip\cover.jpg"#,
      _id: "650a1b2c3d4e5f6071829310",
      folder_id: "lib",
      abs_path: #"C:\photos\2024\Trip\cover.jpg"#,
      address: #"lib:2024\Trip\cover.jpg"#,
      filename: "cover.jpg")
    let homeAsset = SearchAsset(
      id: #"fs:C:\photos\2024\Home\keep.jpg"#,
      _id: "650a1b2c3d4e5f6071829311",
      folder_id: "lib",
      abs_path: #"C:\photos\2024\Home\keep.jpg"#,
      address: #"lib:2024\Home\keep.jpg"#,
      filename: "keep.jpg")
    await cache.write(
      ForYouSnapshot(
        collections: [
          GeneratedSearchCard(
            id: "a", theme: "t", title: "a", result_count: 1, generated_for: CachedCardsStub.day),
          GeneratedSearchCard(
            id: "b", theme: "t", title: "b", result_count: 1, generated_for: CachedCardsStub.day),
        ],
        firstPages: [
          "a": GeneratedSearchAssetPage(results: [tripAsset], total: 1, isSnapshot: true),
          "b": GeneratedSearchAssetPage(results: [homeAsset], total: 1, isSnapshot: true),
        ],
        savedAt: Date()),
      libraryID: Self.library,
      host: host)

    StubURLProtocol.reset()
    let catalog = FPCoreTestSupport.makeCatalog { _ in
      let body = #"{"total": 1, "succeeded": 1, "failed": 0, "items": []}"#
      return (200, Data(body.utf8), ["Content-Type": "application/json"])
    }
    let roots = [LibraryRoot(id: "lib", path: #"C:\photos"#, label: "Photos", fileCount: 2)]
    let core = FPCoreTestSupport.makeCore(
      catalog: catalog, roots: roots, forYouDeletionsDirectory: deletionsDir, test: self)
    let deleteErr = await Self.deleteFileProviderItem(
      core: core,
      identifier: FileProviderIdentifier.folder(folderID: "lib", relativePath: "2024/Trip"))
    XCTAssertNil(deleteErr)

    let stored = await cache.read(libraryID: Self.library, host: host)
    XCTAssertNil(
      stored?.firstPages["a"],
      "Windows root C:\\photos + 2024/Trip marker matches C:\\photos\\2024\\Trip\\cover.jpg")
    XCTAssertEqual(
      stored?.firstPages["b"]?.results.first?.abs_path, #"C:\photos\2024\Home\keep.jpg"#)
    XCTAssertTrue(Self.markerFiles(in: deletionsDir).isEmpty)
  }

  private static func serverAsset(objectID: String, absPath: String) -> SearchAsset {
    let json =
      #"{"id":"fs:\#(absPath)","_id":"\#(objectID)","folder_id":"lib","#
      + #""abs_path":"\#(absPath)","filename":"x.dng"}"#
    return try! JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))
  }

  private static func markerFiles(in dir: URL) -> [URL] {
    ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
      .filter { $0.pathExtension == "json" }
  }

  private static func deleteFileProviderItem(
    core: FileProviderExtensionCore, identifier: FileProviderIdentifier
  ) async -> Error? {
    await withCheckedContinuation { continuation in
      _ = core.deleteItem(
        identifier: NSFileProviderItemIdentifier(identifier.rawValue),
        baseVersion: NSFileProviderItemVersion(
          contentVersion: Data("v1".utf8), metadataVersion: Data("v1".utf8)),
        options: [],
        request: NSFileProviderRequest(),
        completionHandler: { error in continuation.resume(returning: error) })
    }
  }

  private func makeVMForHost(
    _ stub: CachedCardsStub, cache: ForYouCache, host: String, warmer: CoverWarmerProbe? = nil
  ) -> GeneratedSearchCollectionsViewModel {
    let server = URL(string: "https://\(host)")!
    let cfg = URLSessionConfiguration.ephemeral
    cfg.protocolClasses = [StubURLProtocol.self]
    StubURLProtocol.reset()
    StubURLProtocol.responder = { request in stub.respond(to: request) }
    let client = GeneratedSearchClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.unauthenticated(
        server: server, urlSession: URLSession(configuration: cfg)))
    return GeneratedSearchCollectionsViewModel(
      libraryID: Self.library, client: client, cache: cache, cacheHost: host,
      coverWarmer: warmer.map { probe in { await probe.warm($0) } },
      sessionOrder: ForYouSessionOrder(), random: SplitMix64(seed: 21))
  }

  private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0..<400 where !condition() {
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTAssertTrue(condition(), "timed out waiting")
  }
}
