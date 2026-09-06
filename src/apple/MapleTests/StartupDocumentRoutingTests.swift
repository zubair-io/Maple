import MapleCore
import XCTest

@testable import Maple_Exposure

@MainActor
final class StartupDocumentRoutingTests: XCTestCase {
  func testDocumentRemainsQueuedWhileRestorationReplacesSelection() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let restored = folder.appendingPathComponent("restored.dng")
    let requested = folder.appendingPathComponent("opened.dng")
    try Data().write(to: restored)
    try Data().write(to: requested)
    let browser = BrowseViewModel()
    let router = DocumentOpenRouter.isolatedForTesting()
    let (releaseRestore, continuation) = AsyncStream<Void>.makeStream()
    let restoration = Task { @MainActor in
      for await _ in releaseRestore { break }
      browser.loadFolder(url: folder)
    }

    // The warm observer fires while the cold-start task is still suspended.
    router.handle(requested)
    XCTAssertNil(router.consume(afterSourceRestore: false))
    XCTAssertEqual(router.pendingFileURL, requested)
    continuation.yield(())
    continuation.finish()
    await restoration.value
    XCTAssertNil(browser.selectedID, "Restoring a folder clears its selection")

    // Startup drains the pending request only after that replacement settles.
    let accepted = try XCTUnwrap(router.consume(afterSourceRestore: true))
    browser.loadSingleAsset(url: accepted, scopeParentURL: accepted)
    XCTAssertEqual(browser.selectedAsset?.primaryURL, requested)
    XCTAssertNil(router.consume(afterSourceRestore: true), "A delivery is consumed exactly once")
  }

  func testLatestDocumentDuringStartupWinsAndWarmReopenIsImmediate() throws {
    let router = DocumentOpenRouter.isolatedForTesting()
    let first = URL(fileURLWithPath: "/tmp/maple-first.dng")
    let latest = URL(fileURLWithPath: "/tmp/maple-latest.dng")
    router.handle(first)
    XCTAssertNil(router.consume(afterSourceRestore: false))
    router.handle(latest)
    XCTAssertNil(router.consume(afterSourceRestore: false))
    XCTAssertEqual(router.consume(afterSourceRestore: true), latest)
    router.handle(first)
    XCTAssertEqual(router.consume(afterSourceRestore: true), first)
  }

  func testDeepLinkAlsoSurvivesStartupAndConsumesOnce() throws {
    let router = DeepLinkRouter.isolatedForTesting()
    router.handle(try XCTUnwrap(URL(string: "maple://image/first")))
    XCTAssertNil(router.consume(afterSourceRestore: false))
    router.handle(try XCTUnwrap(URL(string: "maple://image/latest")))
    XCTAssertNil(router.consume(afterSourceRestore: false))
    XCTAssertEqual(router.consume(afterSourceRestore: true), .image(id: "latest"))
    XCTAssertNil(router.consume(afterSourceRestore: true))
    router.handle(try XCTUnwrap(URL(string: "maple://source/folder")))
    XCTAssertEqual(router.consume(afterSourceRestore: true), .source(id: "folder"))
  }
}
