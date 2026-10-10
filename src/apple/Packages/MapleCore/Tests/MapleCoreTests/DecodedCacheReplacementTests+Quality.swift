import CoreImage
import Foundation
import XCTest

@testable import MapleCore

extension DecodedCacheReplacementTests {
  private var qualityFixture: URL {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    return root.appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }

  private actor NormalizationCount {
    var count = 0
    func record() { count += 1 }
  }

  func testJoinedDecodeReturnsPublishedPixelsAndQuality() async throws {
    let asset = AssetRef(url: qualityFixture)
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let calls = NormalizationCount()
    let normalize: @Sendable (CIImage, AssetRef) async -> CIImage = { image, _ in
      await calls.record()
      // Keep publication in flight while the second same-identity request joins.
      try? await Task.sleep(for: .milliseconds(100))
      return image.transformed(by: CGAffineTransform(translationX: 3, y: 4))
    }
    async let first = renderer.sharedDecode(
      asset: asset, target: CGSize(width: 16, height: 16), profile: .neutral,
      quality: .amaze, normalize: normalize)
    async let second = renderer.sharedDecode(
      asset: asset, target: CGSize(width: 16, height: 16), profile: .neutral,
      quality: .amaze, normalize: normalize)
    let (firstImage, secondImage) = await (first, second)
    let snapshot = await renderer.snapshot(forAsset: asset)
    XCTAssertNotNil(firstImage)
    XCTAssertTrue(firstImage === secondImage)
    XCTAssertTrue(secondImage === snapshot.image)
    XCTAssertEqual(snapshot.quality, .amaze)
    let count = await calls.count
    XCTAssertEqual(count, 1, "A single-flight join waits for the owner's normalized publication")
  }

  func testSizedQualityUpgradeReplacesEqualResolutionPreview() async throws {
    let asset = AssetRef(url: qualityFixture)
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let target = CGSize(width: 8, height: 8)
    let preview = await renderer.sharedDecode(
      asset: asset, target: target, profile: .neutral, quality: .preview
    ) { image, _ in image }
    XCTAssertNotNil(preview)
    let before = await renderer.snapshot(forAsset: asset)
    XCTAssertEqual(before.quality, .preview)
    for quality: PipelineRenderer.Quality in [.full, .amaze] {
      let result = await renderer.sharedDecode(
        asset: asset, target: target, profile: .neutral, quality: quality
      ) { image, _ in image }
      XCTAssertNotNil(result)
      let after = await renderer.snapshot(forAsset: asset)
      XCTAssertEqual(after.quality, quality)
      XCTAssertEqual(after.rawResolution, before.rawResolution)
      XCTAssertGreaterThan(after.decodeGeneration, before.decodeGeneration)
    }
  }

  func testFastDecodeRetainsHigherQualityPixelsAndMatchingMetadata() async throws {
    let asset = AssetRef(url: qualityFixture)
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let refine = await renderer.sharedDecode(
      asset: asset, target: CGSize(width: 16, height: 16), profile: .neutral, quality: .amaze
    ) { image, _ in image }
    XCTAssertNotNil(refine)
    let before = await renderer.snapshot(forAsset: asset)
    let fast = await renderer.sharedDecode(
      asset: asset, target: CGSize(width: 8, height: 8), profile: .neutral, quality: .preview
    ) { image, _ in image }
    let after = await renderer.snapshot(forAsset: asset)
    XCTAssertEqual(after.quality, .amaze)
    XCTAssertEqual(after.decodeGeneration, before.decodeGeneration)
    XCTAssertEqual(fast?.extent, refine?.extent)
    XCTAssertTrue(fast === after.image, "The image returned must own the snapshot's fit quality")
  }

  func testFullDecodeReportsActualQualityAndSeedsClearIt() async throws {
    let asset = AssetRef(url: qualityFixture)
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let result = await renderer.sharedDecode(
      asset: asset, profile: .neutral, quality: .preview
    ) { image, _ in image }
    XCTAssertNotNil(result)
    let full = await renderer.snapshot(forAsset: asset)
    XCTAssertEqual(full.quality, AmazeFlag.isEnabled ? .amaze : .full)
    await renderer.invalidate()
    let invalidated = await renderer.snapshot(forAsset: asset)
    XCTAssertNil(invalidated.quality)
    let image = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8))
    await renderer._testSeedDecodedCache(
      asset: asset, decoded: image, rawResolution: image.extent.size, quality: .amaze)
    await renderer.seed(asset: asset, decoded: image, rawResolution: image.extent.size)
    let seeded = await renderer.snapshot(forAsset: asset)
    XCTAssertNil(seeded.quality)
    await renderer.invalidate()
    let didSeed = await renderer.seedIfUnpopulated(
      asset: asset, decoded: image, rawResolution: image.extent.size)
    XCTAssertTrue(didSeed)
    let seededIfEmpty = await renderer.snapshot(forAsset: asset)
    XCTAssertNil(seededIfEmpty.quality)
  }
}
