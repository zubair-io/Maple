// EditorSeedStoreTests.swift — #5755: which still the editor draws as its
// canvas while a photo's real pixels are on their way.

import CoreGraphics
import XCTest

@testable import MapleCore

@MainActor
final class EditorSeedStoreTests: XCTestCase {
  private func image(width: Int, height: Int) throws -> CGImage {
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    return try XCTUnwrap(context.makeImage())
  }

  func testAThumbnailArrivingAfterTheDisplayPreviewDoesNotReplaceIt() throws {
    let store = EditorSeedStore()
    let asset = UUID()
    let display = try image(width: 1280, height: 853)
    store.begin(asset)
    store.publish(display, for: asset, isDisplayPreview: true)
    store.publish(try image(width: 512, height: 341), for: asset, isDisplayPreview: false)
    XCTAssertTrue(store.image(for: asset) === display)
    XCTAssertTrue(store.hasDisplayPreview(for: asset))
  }

  func testTheDisplayPreviewUpgradesTheThumbnail() throws {
    let store = EditorSeedStore()
    let asset = UUID()
    let display = try image(width: 1280, height: 853)
    store.begin(asset)
    store.publish(try image(width: 512, height: 341), for: asset, isDisplayPreview: false)
    store.publish(display, for: asset, isDisplayPreview: true)
    XCTAssertTrue(store.image(for: asset) === display)
  }

  func testOpeningAnotherPhotoDropsThePreviousSeed() throws {
    let store = EditorSeedStore()
    let first = UUID()
    let second = UUID()
    store.begin(first)
    store.publish(try image(width: 512, height: 341), for: first, isDisplayPreview: true)
    store.begin(second)
    XCTAssertNil(store.image(for: first))
    XCTAssertNil(store.image(for: second))
    XCTAssertFalse(store.hasDisplayPreview(for: second))
  }

  func testALateLoadForAPhotoNoLongerOpenIsDropped() throws {
    let store = EditorSeedStore()
    let first = UUID()
    let second = UUID()
    store.begin(first)
    store.begin(second)
    store.publish(try image(width: 512, height: 341), for: first, isDisplayPreview: false)
    XCTAssertNil(store.image(for: first))
    XCTAssertNil(store.image(for: second))
  }

  func testBeginningTheSamePhotoAgainKeepsItsSeed() throws {
    let store = EditorSeedStore()
    let asset = UUID()
    let seed = try image(width: 512, height: 341)
    store.begin(asset)
    store.publish(seed, for: asset, isDisplayPreview: false)
    store.begin(asset)
    XCTAssertTrue(store.image(for: asset) === seed)
  }
}
