import XCTest

@testable import MapleCloudKit

extension GeneratedSearchCollectionsCacheTests {
  func testPartialTrashKeepsFailedCoverInLoadedViewModelWhileOffline() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.mixedPageSnapshot(), libraryID: Self.library, host: Self.host)
    let vm = makeVM(CachedCardsStub(covers: [:]), cache: cache)
    StubURLProtocol.responder = { _ in .failure(URLError(.notConnectedToInternet)) }

    await vm.load()
    XCTAssertEqual(vm.firstPages["a"]?.results.map(\.id), ["failed", "trashed"])
    await cache.forgetAssetsPreservingPages(
      host: Self.host, libraryFolderID: "lib", folderPath: "/p", assetIDs: ["trashed"])
    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages["a"]?.results.map(\.id), ["failed"])

    await vm.dropTrashedCovers()
    XCTAssertEqual(vm.covers["a"]?.id, "failed")
    XCTAssertEqual(vm.firstPages["a"]?.results.map(\.id), ["failed"])
  }

  func testPartialTrashDuringRefreshKeepsFailedCoverWhenRetryIsOffline() async {
    let cache = ForYouCache(directory: directory)
    await cache.write(Self.mixedPageSnapshot(), libraryID: Self.library, host: Self.host)
    let warmer = CoverWarmerProbe(duringWarm: { _ in
      await cache.forgetAssetsPreservingPages(
        host: Self.host, libraryFolderID: "lib", folderPath: "/p", assetIDs: ["trashed"])
      StubURLProtocol.responder = { _ in .failure(URLError(.notConnectedToInternet)) }
    })
    let vm = makeVM(CachedCardsStub(covers: ["a": "new"]), cache: cache, warmer: warmer)

    await vm.load()

    let stored = await cache.read(libraryID: Self.library, host: Self.host)
    XCTAssertEqual(stored?.firstPages["a"]?.results.map(\.id), ["failed"])
    XCTAssertEqual(vm.covers["a"]?.id, "failed")
    XCTAssertEqual(vm.firstPages["a"]?.results.map(\.id), ["failed"])
  }

  private static func mixedPageSnapshot() -> ForYouSnapshot {
    let original = snapshot(["a": "failed"])
    return ForYouSnapshot(
      collections: original.collections,
      firstPages: [
        "a": GeneratedSearchAssetPage(
          results: [asset("failed"), asset("trashed")], total: 2, isSnapshot: true)
      ],
      savedAt: Date())
  }
}
