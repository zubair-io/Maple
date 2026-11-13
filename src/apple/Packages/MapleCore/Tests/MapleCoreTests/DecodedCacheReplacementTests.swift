import CoreImage
import Foundation
import XCTest

@testable import MapleCore

final class DecodedCacheReplacementTests: XCTestCase {
  private actor Gate {
    private var entered = false
    private var entryWaiters: [CheckedContinuation<Void, Never>] = []
    private var release: CheckedContinuation<Void, Never>?
    func hold() async {
      entered = true
      for waiter in entryWaiters { waiter.resume() }
      entryWaiters.removeAll()
      await withCheckedContinuation { release = $0 }
    }
    func waitForEntry() async {
      if entered { return }
      await withCheckedContinuation { entryWaiters.append($0) }
    }
    func open() {
      release?.resume()
      release = nil
    }
  }

  private var fixture: URL {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    return root.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }

  func testLateNormalizationCannotClearOrPublishOverReplacement() async throws {
    let asset = AssetRef(url: fixture)
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let oldGate = Gate()
    let newGate = Gate()
    let old = Task {
      await renderer.sharedDecode(
        asset: asset, target: CGSize(width: 64, height: 64), profile: .neutral
      ) { image, _ in
        await oldGate.hold()
        return image
      }
    }
    await oldGate.waitForEntry()
    let next = Task {
      await renderer.sharedDecode(
        asset: asset, target: CGSize(width: 64, height: 64), profile: .auto
      ) { image, _ in
        await newGate.hold()
        return image
      }
    }
    await newGate.waitForEntry()
    let nextFlag = await renderer.decodeCancelFlag
    await oldGate.open()
    let oldResult = await old.value
    XCTAssertNil(oldResult)
    let preservedFlag = await renderer.decodeCancelFlag
    XCTAssertTrue(
      nextFlag === preservedFlag, "Old normalization must not clear replacement task identity")
    let before = await renderer.snapshot(forAsset: asset)
    XCTAssertNil(before.image, "Superseded pixels must not enter the decoded cache")
    await newGate.open()
    let nextResult = await next.value
    XCTAssertNotNil(nextResult)
    let after = await renderer.snapshot(forAsset: asset)
    XCTAssertEqual(after.profile, .auto)
  }

  func testCancelledDecodeCannotClearSameAssetReplacement() async throws {
    let bytes = try Data(contentsOf: fixture)
    let sourceGate = Gate()
    let normalizeGate = Gate()
    let asset = AssetRef(displayName: "remote.dng", hintExtension: "dng") {
      await sourceGate.hold()
      return bytes
    }
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let old = Task {
      await renderer.sharedDecode(
        asset: asset, target: CGSize(width: 64, height: 64), profile: .neutral
      ) { image, _ in image }
    }
    await sourceGate.waitForEntry()
    let oldFlag = await renderer.decodeCancelFlag
    let next = Task {
      await renderer.sharedDecode(
        asset: asset, target: CGSize(width: 64, height: 64), profile: .auto
      ) { image, _ in
        await normalizeGate.hold()
        return image
      }
    }
    let deadline = Date().addingTimeInterval(3)
    while await renderer.decodeCancelFlag === oldFlag, Date() < deadline { await Task.yield() }
    let nextFlag = await renderer.decodeCancelFlag
    XCTAssertFalse(nextFlag === oldFlag)
    await sourceGate.open()
    await normalizeGate.waitForEntry()
    let oldResult = await old.value
    XCTAssertNil(oldResult)
    let preservedFlag = await renderer.decodeCancelFlag
    XCTAssertTrue(
      nextFlag === preservedFlag, "Cancelled A must not clear B just because asset IDs match")
    await normalizeGate.open()
    let nextResult = await next.value
    XCTAssertNotNil(nextResult)
  }
}
