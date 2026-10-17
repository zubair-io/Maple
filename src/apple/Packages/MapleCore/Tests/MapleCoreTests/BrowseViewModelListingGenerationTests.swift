// BrowseViewModelListingGenerationTests.swift
// The grids scroll back to the top whenever `listingGeneration` moves, so it
// must advance once per folder that finishes loading — and only then (#4792).

import Foundation
import Testing

@testable import MapleCore

@MainActor
struct BrowseViewModelListingGenerationTests {

  private func makeFolder(_ name: String) throws -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-listing-\(name)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: dir.appendingPathComponent("child", isDirectory: true),
      withIntermediateDirectories: true)
    return dir
  }

  @Test("each completed folder load publishes a new listing generation")
  func advancesPerFolderLoad() async throws {
    let first = try makeFolder("first")
    let second = try makeFolder("second")
    defer {
      try? FileManager.default.removeItem(at: first)
      try? FileManager.default.removeItem(at: second)
    }
    let vm = BrowseViewModel()
    let initial = vm.listingGeneration

    await vm.loadFolder(url: first)
    let afterFirst = vm.listingGeneration
    await vm.loadFolder(url: second)

    #expect(afterFirst == initial &+ 1)
    #expect(vm.listingGeneration == afterFirst &+ 1)
  }

  @Test("a failed folder load leaves the listing generation alone")
  func failedLoadDoesNotAdvance() async {
    let missing = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-listing-missing-\(UUID().uuidString)", isDirectory: true)
    let vm = BrowseViewModel()
    let initial = vm.listingGeneration

    await vm.loadFolder(url: missing)

    #expect(vm.loadError != nil)
    #expect(vm.listingGeneration == initial)
  }

  @Test("selection changes inside a listing do not advance it")
  func selectionDoesNotAdvance() async throws {
    let dir = try makeFolder("selection")
    defer { try? FileManager.default.removeItem(at: dir) }
    let vm = BrowseViewModel()
    await vm.loadFolder(url: dir)
    let loaded = vm.listingGeneration

    vm.assets = [AssetRef.preview(displayName: "IMG_0001.dng")]
    vm.selectedID = vm.assets.first?.id

    #expect(vm.listingGeneration == loaded)
  }
}
