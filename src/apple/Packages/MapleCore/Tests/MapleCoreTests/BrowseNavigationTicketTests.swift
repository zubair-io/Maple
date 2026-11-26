// BrowseNavigationTicketTests.swift — a navigation that waits (sign-in, LAN
// discovery) before loading must not replace a folder picked during the wait.

import XCTest

@testable import MapleCore

@MainActor
final class BrowseNavigationTicketTests: XCTestCase {

  func testTicketStaysCurrentWithoutAnotherNavigation() {
    let vm = BrowseViewModel()
    let ticket = vm.beginNavigation()
    XCTAssertTrue(vm.isCurrent(ticket))
  }

  func testLocalFolderPickedDuringTheWaitInvalidatesTheTicket() {
    let vm = BrowseViewModel()
    let cloudTicket = vm.beginNavigation()
    vm.beginLoadingFilesystemFolder()
    XCTAssertFalse(vm.isCurrent(cloudTicket))
  }

  func testNavigationLeavesTheLoadAlreadyRunningInCharge() {
    let vm = BrowseViewModel()
    vm.beginLoadingFilesystemFolder()
    let running = vm.loadGeneration
    let ticket = vm.beginNavigation()
    XCTAssertTrue(vm.isLoading)
    XCTAssertEqual(vm.loadGeneration, running)
    XCTAssertTrue(vm.isCurrent(ticket))
  }

  func testLaterNavigationWinsOverAnEarlierOne() {
    let vm = BrowseViewModel()
    let first = vm.beginNavigation()
    let second = vm.beginNavigation()
    XCTAssertFalse(vm.isCurrent(first))
    XCTAssertTrue(vm.isCurrent(second))
  }

  func testPhotosFilterAndClearInvalidateTheTicket() {
    let vm = BrowseViewModel()
    let beforePhotos = vm.beginNavigation()
    vm.beginLoadingPhotosFilter()
    XCTAssertFalse(vm.isCurrent(beforePhotos))

    let beforeClear = vm.beginNavigation()
    vm.clear()
    XCTAssertFalse(vm.isCurrent(beforeClear))
  }

  func testLocalFolderLoadedDuringTheWaitKeepsTheGrid() async throws {
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-nav-ticket-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: folder.appendingPathComponent("child", isDirectory: true),
      withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let vm = BrowseViewModel()

    let cloudTicket = vm.beginNavigation()
    await vm.loadFolder(url: folder)

    XCTAssertFalse(vm.isCurrent(cloudTicket))
    XCTAssertEqual(vm.subfolders.map(\.lastPathComponent), ["child"])
  }
}
