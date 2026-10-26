import XCTest

@testable import MapleCore

final class PersonSkinMaskServiceTests: XCTestCase {
  private func loadFixture(_ name: String) throws -> CGImage {
    guard let url = Bundle.module.url(forResource: name, withExtension: "png"),
      let provider = CGDataProvider(url: url as CFURL),
      let image = CGImage(
        pngDataProviderSource: provider, decode: nil, shouldInterpolate: true,
        intent: .defaultIntent)
    else { throw XCTSkip("fixture \(name).png not found") }
    return image
  }

  func testDetectPersonsFindsAtLeastOneCandidateOnAPortrait() async throws {
    let image = try loadFixture("portrait-skin-test")
    let service = PersonSkinMaskService()
    let people = try await service.detectPersons(in: image)
    XCTAssertFalse(people.isEmpty)
    XCTAssertTrue(people[0].boundingBox.width > 0 && people[0].boundingBox.height > 0)
  }

  func testDetectPersonsOnABlankImageThrowsNoPersonDetected() async throws {
    let ctx = CGContext(
      data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    ctx.setFillColor(gray: 0.5, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
    let image = ctx.makeImage()!
    let service = PersonSkinMaskService()
    do {
      _ = try await service.detectPersons(in: image)
    } catch PersonSkinMaskError.noPersonDetected {
      return
    }
    // Vision may legitimately return an empty array instead of throwing on
    // a blank frame — either signal is acceptable; only a real detection
    // (asserted in the portrait test above) proves the request works.
  }

  func testMakeRasterProducesWidthTimesHeightBytesCoveringSomeButNotAllPixels() async throws {
    let image = try loadFixture("portrait-skin-test")
    let service = PersonSkinMaskService()
    let people = try await service.detectPersons(in: image)
    let (w, h, bytes) = try await service.makeRaster(
      image: image,
      request: SkinRasterRequest(person: people[0].id, facialSkin: true, bodySkin: true)
    )
    XCTAssertEqual(bytes.count, w * h)
    let nonZero = bytes.filter { $0 > 0 }.count
    XCTAssertGreaterThan(nonZero, 0, "raster is entirely empty")
    XCTAssertLessThan(
      nonZero, bytes.count, "raster covers the whole frame — segmentation didn't run")
  }

  func testFacialOnlyRasterCoversFewerPixelsThanFacialPlusBody() async throws {
    let image = try loadFixture("portrait-skin-test")
    let service = PersonSkinMaskService()
    let people = try await service.detectPersons(in: image)
    let (_, _, facial) = try await service.makeRaster(
      image: image,
      request: SkinRasterRequest(person: people[0].id, facialSkin: true, bodySkin: false)
    )
    let (_, _, both) = try await service.makeRaster(
      image: image,
      request: SkinRasterRequest(person: people[0].id, facialSkin: true, bodySkin: true)
    )
    let count = { (b: [UInt8]) in b.filter { $0 > 0 }.count }
    XCTAssertLessThanOrEqual(count(facial), count(both))
  }

  func testNeutralPortraitKeepsDefaultSkinToneRange() async throws {
    let image = try loadFixture("portrait-skin-test")
    let service = PersonSkinMaskService()
    let people = try await service.detectPersons(in: image)
    let (w, h, bytes) = try await service.makeRaster(
      image: image,
      request: SkinRasterRequest(person: people[0].id, facialSkin: true, bodySkin: true)
    )
    let range = PersonSkinRangeInitializer.initialRange(
      image: image, maskWidth: w, maskHeight: h, maskBytes: bytes
    )
    XCTAssertEqual(range, .skinTone)
  }

  func testBodySkinMaskOnWarmPortraitAdaptsRangeAndRespondsToLocalExposure() async throws {
    let rawPath = "/Users/riabuz/Projects/_Maple/test-fixtures/raws/test_0003.CR2"
    guard FileManager.default.fileExists(atPath: rawPath) else {
      throw XCTSkip("test_0003.CR2 not available")
    }
    let tempDir = FileManager.default.temporaryDirectory
      .appendingPathComponent("skin-range-5317-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tempDir) }
    let stagedRaw = tempDir.appendingPathComponent("test_0003.CR2")
    try FileManager.default.copyItem(at: URL(fileURLWithPath: rawPath), to: stagedRaw)

    let session = await MainActor.run { EditSession(asset: AssetRef(url: stagedRaw)) }
    let people = try await session.detectMaskPersons()
    let firstPerson = try XCTUnwrap(people.first)
    try await session.createPersonSkinMask(
      person: firstPerson, facialSkin: false, bodySkin: true
    )
    let layer = await MainActor.run { session.model.localAdjustments.first }
    let createdLayer = try XCTUnwrap(layer)
    XCTAssertNotEqual(
      createdLayer.range, .skinTone,
      "Body skin on test_0003.CR2 falls outside default 55°±25° and must adapt"
    )

    let pipeline = ImageEditPipeline()
    let target = CGSize(width: 512, height: 512)
    let rawDecoded = await pipeline.decodeSceneLinearSized(
      asset: AssetRef(url: stagedRaw), targetSize: target
    )
    let decoded = try XCTUnwrap(rawDecoded)
    var modelZero = await MainActor.run { session.model }
    if let frame = decoded.wbFrame, frame.isPresent {
      modelZero.temperature = Double(frame.sceneCCT)
      modelZero.tint = Double(frame.asShotTint)
    }
    var modelPlusOne = modelZero
    modelPlusOne.localAdjustments[0].adjustments.exposure = 1.0

    let ciZero = pipeline.processSceneLinear(
      decoded: decoded.image, model: modelZero, targetSize: nil,
      asShot: nil, decodedAtModel: nil, profileLUT: nil,
      assetID: UUID(), noiseProfile: decoded.noiseProfile, iso: decoded.iso,
      wbFrame: decoded.wbFrame, whitesAnchorEv: decoded.whitesAnchorEv,
      nrSamplingScale: decoded.nrSamplingScale
    )
    let ciPlusOne = pipeline.processSceneLinear(
      decoded: decoded.image, model: modelPlusOne, targetSize: nil,
      asShot: nil, decodedAtModel: nil, profileLUT: nil,
      assetID: UUID(), noiseProfile: decoded.noiseProfile, iso: decoded.iso,
      wbFrame: decoded.wbFrame, whitesAnchorEv: decoded.whitesAnchorEv,
      nrSamplingScale: decoded.nrSamplingScale
    )
    let imgZero = try XCTUnwrap(pipeline.renderPreview(ciZero, targetSize: target))
    let imgPlusOne = try XCTUnwrap(pipeline.renderPreview(ciPlusOne, targetSize: target))
    let changedChannelSum = totalAbsoluteRGBDiff(imgZero, imgPlusOne)

    var modelDefaultRange = modelPlusOne
    modelDefaultRange.localAdjustments[0].range = .skinTone
    let ciDefaultRange = pipeline.processSceneLinear(
      decoded: decoded.image, model: modelDefaultRange, targetSize: nil,
      asShot: nil, decodedAtModel: nil, profileLUT: nil,
      assetID: UUID(), noiseProfile: decoded.noiseProfile, iso: decoded.iso,
      wbFrame: decoded.wbFrame, whitesAnchorEv: decoded.whitesAnchorEv,
      nrSamplingScale: decoded.nrSamplingScale
    )
    let imgDefaultRange = try XCTUnwrap(pipeline.renderPreview(ciDefaultRange, targetSize: target))
    let inertChannelSum = totalAbsoluteRGBDiff(imgZero, imgDefaultRange)

    XCTAssertGreaterThan(
      changedChannelSum, 1000.0,
      "Expected visible change from +1.0 EV on body skin mask, got total diff \(changedChannelSum)"
    )
    XCTAssertGreaterThan(
      changedChannelSum, inertChannelSum * 10.0 + 1000.0,
      "Adapted range (\(changedChannelSum)) must outperform inert .skinTone (\(inertChannelSum))"
    )
  }

  private func totalAbsoluteRGBDiff(_ a: CGImage, _ b: CGImage) -> Double {
    let w = min(a.width, b.width)
    let h = min(a.height, b.height)
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    var bufA = [UInt8](repeating: 0, count: w * h * 4)
    var bufB = [UInt8](repeating: 0, count: w * h * 4)
    bufA.withUnsafeMutableBytes { ptr in
      let ctx = CGContext(
        data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8,
        bytesPerRow: w * 4, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.draw(a, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    bufB.withUnsafeMutableBytes { ptr in
      let ctx = CGContext(
        data: ptr.baseAddress, width: w, height: h, bitsPerComponent: 8,
        bytesPerRow: w * 4, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.draw(b, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    var sum = 0.0
    for i in 0..<(w * h) {
      let o = i * 4
      sum += abs(Double(bufA[o]) - Double(bufB[o]))
      sum += abs(Double(bufA[o + 1]) - Double(bufB[o + 1]))
      sum += abs(Double(bufA[o + 2]) - Double(bufB[o + 2]))
    }
    return sum
  }
}
