import CoreImage
import Foundation
import MapleBackup
import XCTest

@testable import MapleCore

final class RemovalModelStateTests: XCTestCase {
  private func fixture(_ name: String, _ ext: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "removal/calibration"))
    return try Data(contentsOf: url)
  }

  private func stage() throws -> (URL, String) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("photo.dng")
    try fixture("source", "dng").write(to: raw)
    let xml = String(decoding: try fixture("saved", "xmp"), as: UTF8.self)
    let assets = directory.appendingPathComponent(".maple/inpaint")
    try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
    for (name, ext, suffix) in [("mask", "mimf", "mask"), ("patch", "f16", "f16")] {
      let bytes = try fixture(name, ext)
      let digest = String(try RemovalBridge.digest(bytes).dropFirst(7))
      try bytes.write(to: assets.appendingPathComponent("\(digest).\(suffix)"))
    }
    return (raw, xml)
  }

  func testValidatedModelSnapshotsRemainBackwardCompatibleAndSourceBound() throws {
    let xml = String(decoding: try fixture("saved", "xmp"), as: UTF8.self)
    var model = try XMPParser.parse(xml).0
    let records = try XCTUnwrap(model.inpaintRemovals)
    XCTAssertFalse(records.isEmpty)
    XCTAssertTrue(model.isVisuallyEditedBeyondWhiteBalance)
    XCTAssertEqual(
      try JSONDecoder().decode(AdjustmentModel.self, from: JSONEncoder().encode(model)), model)
    var old = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(model)) as? [String: Any])
    old.removeValue(forKey: "inpaintRemovals")
    XCTAssertNil(
      try JSONDecoder().decode(
        AdjustmentModel.self, from: JSONSerialization.data(withJSONObject: old)
      ).inpaintRemovals)
    old["inpaintRemovals"] = "[{\"kind\":\"removal\",\"schema\":999}]"
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        AdjustmentModel.self, from: JSONSerialization.data(withJSONObject: old)))
    XCTAssertThrowsError(try RemovalRecords(json: "not JSON"))
    XCTAssertThrowsError(
      try XMPParser.parse(
        xml.replacingOccurrences(of: "&quot;schema&quot;:4", with: "&quot;schema&quot;:999")))
    XCTAssertEqual(RawCoreBridge.stripAppleGPUStages(model).inpaintRemovals, records)
    let transferred = AdjustmentGroupMerge.merged(
      .default, applying: model, groups: Set(AdjustmentGroup.allCases))
    XCTAssertNil(transferred.inpaintRemovals, "Accepted patches cannot be copied to another source")
    model.inpaintRemovals = try RemovalRecords(json: "[]")
    XCTAssertFalse(model.isVisuallyEditedBeyondWhiteBalance)
  }

  func testAliasAndScalarPropertyRoundTripsEmitOneOwnedStackAndKeepForeignBytes() throws {
    let original = String(decoding: try fixture("saved", "xmp"), as: UTF8.self)
    let records = try XCTUnwrap(RemovalXMPRecords.read(Data(original.utf8)))
    let foreign =
      "<m:InpaintRemovals xmlns:m=\"urn:foreign\" keep=\"unchanged\">opaque</m:InpaintRemovals>"
    for uri in [XMPCanonical.pappNamespaceURI, "http://ns.justmaple.app/1.0/"] {
      for payload in [
        "m:InpaintRemovals=\"\(XMPSerializer.escapeXMLAttr(records))\"/>",
        "><m:InpaintRemovals><![CDATA[\(records)]]></m:InpaintRemovals>\(foreign)</r:Description>",
      ] {
        let xml: String =
          "<r:RDF xmlns:r=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><r:Description xmlns:m=\"\(uri)\" \(payload)</r:RDF>"
        let (model, culling) = try XMPParser.parse(xml)
        let bucket = XMPParser.parsePassthrough(xml)
        var authoredMetadata = XmpMetadata()
        authoredMetadata.title = "Saved removal"
        for metadata in [XmpMetadata(), authoredMetadata] {
          let saved = XMPSerializer.serialize(
            model: model, culling: culling, metadata: metadata, passthrough: bucket)
          XCTAssertEqual(try RemovalXMPRecords.read(Data(saved.utf8)), records)
          XCTAssertEqual(saved.components(separatedBy: "papp:InpaintRemovals=").count, 2)
          XCTAssertTrue(XMPKnownFields.isKnownAttribute("papp:InpaintRemovals"))
          XCTAssertFalse(saved.contains("m:InpaintRemovals=\""))
          if payload.contains(foreign) { XCTAssertTrue(saved.contains(foreign)) }
          let reopened = try XMPParser.parse(saved)
          XCTAssertEqual(
            XMPSerializer.serialize(
              model: reopened.0, culling: reopened.1, metadata: XMPParser.parseMetadata(saved),
              passthrough: XMPParser.parsePassthrough(saved)), saved)
        }
      }
    }
  }

  func testLiveSnapshotTemporaryDecodeAndCacheIdentityIncludeAcceptedPixels() async throws {
    let (raw, xml) = try stage()
    var model = try XMPParser.parse(xml).0
    model.autoExposure = .off
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try XMPSerializer.serialize(model: .default, culling: CullingState()).write(
      to: sidecar, atomically: true, encoding: .utf8)
    let asset = AssetRef(url: raw)
    let actor = RenderActor(pipeline: ImageEditPipeline())
    let image = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 16, height: 8))
    await actor._testSeedDecodedCache(
      asset: asset, decoded: image, rawResolution: CGSize(width: 16, height: 8))
    let originalIsFresh = await actor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(originalIsFresh)
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    let savedIsFresh = await actor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertFalse(savedIsFresh)
    XCTAssertEqual(RenderActor.bakedModel(for: asset)?.inpaintRemovals, model.inpaintRemovals)
    let saved = try RawCoreBridge.withStrippedModelXMP(model) { temporary in
      let temporary = try XCTUnwrap(temporary)
      XCTAssertEqual(
        try XMPParser.parse(data: Data(contentsOf: temporary)).0.inpaintRemovals,
        model.inpaintRemovals)
      return try PipelineRenderer.renderSceneLinearSized(
        rawPath: raw, xmpPath: temporary, quality: .amaze, maxLongEdge: 64,
        autoExposureOverride: .off)
    }
    let expected = try PipelineRenderer.renderSceneLinearSized(
      rawPath: raw, xmpPath: sidecar, quality: .amaze, maxLongEdge: 64, autoExposureOverride: .off)
    XCTAssertEqual(saved.pixels, expected.pixels)
    XCTAssertEqual(saved.whitesAnchorEv, expected.whitesAnchorEv)
  }

  func testConfirmedLocalSaveUpdatesCacheAndOrdinarySavesCannotAuthorOrUndoRemovals() async throws {
    let (raw, xml) = try stage()
    let records = try XCTUnwrap(try XMPParser.parse(xml).0.inpaintRemovals)
    let store = XMPSidecarStore(rawURL: raw)
    var incoming = AdjustmentModel.default
    incoming.inpaintRemovals = records
    try await store.writeConfirmed(model: incoming, culling: CullingState())
    let ordinary = try await store.load().0.inpaintRemovals
    XCTAssertNil(ordinary)
    try await store.writeRemovalConfirmed(
      records: records.json, expectedRecords: "[]", model: .default, culling: CullingState())
    let confirmed = try await store.load().0.inpaintRemovals
    XCTAssertEqual(confirmed, records)
    try await store.writeConfirmed(model: .default, culling: CullingState())
    let preserved = try await store.load().0.inpaintRemovals
    XCTAssertEqual(preserved, records)
    XCTAssertEqual(
      try XMPParser.parse(data: Data(contentsOf: SidecarPath.sidecarURL(for: raw))).0
        .inpaintRemovals, records)
    try await store.writeRemovalConfirmed(
      records: "[]", expectedRecords: records.json, model: incoming, culling: CullingState())
    let cleared = try await store.load().0.inpaintRemovals
    XCTAssertNil(cleared, "Explicit clearing restores the default absent representation")
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source", "dng"))
  }

  func testPhotoKitOrdinaryWritePreservesDiskRecordsInsteadOfStaleIncomingState() async throws {
    let (raw, xml) = try stage()
    let sidecarRoot = raw.deletingLastPathComponent().appendingPathComponent("sidecars")
    try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)
    let backing = AppSupportSidecarStore(root: sidecarRoot)
    try backing.write(phassetLocalId: "photo", xmp: xml)
    let store = PhotoKitSidecarStore(phassetLocalId: "photo", sidecars: backing)
    _ = try await store.load()
    try await store.writeConfirmed(model: .default, culling: CullingState())
    let saved = try XCTUnwrap(backing.read(phassetLocalId: "photo"))
    let cached = try await store.load().0.inpaintRemovals
    XCTAssertEqual(cached, try XMPParser.parse(saved).0.inpaintRemovals)
    XCTAssertEqual(
      try XMPParser.parse(saved).0.inpaintRemovals, try XMPParser.parse(xml).0.inpaintRemovals)
  }

  func testFilesystemProtocolWritePreservesAcceptedPixelsAndForeignXML() async throws {
    let (raw, xml) = try stage()
    let foreign = "<foreign:History original=\"keep its bytes\"/>"
    let input = xml.replacingOccurrences(
      of: "papp:InpaintRemovals=",
      with: "xmlns:foreign=\"urn:fixture\" foreign:Keep=\"unchanged\" papp:InpaintRemovals="
    )
    .replacingOccurrences(of: "/>", with: ">\(foreign)</rdf:Description>")
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try input.write(to: sidecar, atomically: true, encoding: .utf8)
    let source = FilesystemSource()
    try await source.writeXMP(
      Sidecar(model: .default, culling: CullingState(stars: 4)),
      for: ImageRef(id: "photo", displayName: "photo.dng", url: raw))
    let saved = try String(contentsOf: sidecar, encoding: .utf8)
    XCTAssertEqual(
      try XMPParser.parse(saved).0.inpaintRemovals, try XMPParser.parse(xml).0.inpaintRemovals)
    XCTAssertTrue(saved.contains(foreign))
    XCTAssertTrue(saved.contains("foreign:Keep=\"unchanged\""))
    XCTAssertEqual(try XMPParser.parse(saved).1.stars, 4)
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source", "dng"))
  }

  func testMalformedOwnedSidecarCannotValidateOrSeedAnOriginalCache() async throws {
    let (raw, xml) = try stage()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try XMPSerializer.serialize(model: .default, culling: CullingState())
      .write(to: sidecar, atomically: true, encoding: .utf8)
    let asset = AssetRef(url: raw)
    let image = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 16, height: 8))
    let actor = RenderActor(pipeline: ImageEditPipeline())
    await actor.seed(asset: asset, decoded: image, rawResolution: image.extent.size)
    try xml.replacingOccurrences(of: "&quot;schema&quot;:4", with: "&quot;schema&quot;:999")
      .write(to: sidecar, atomically: true, encoding: .utf8)
    let fresh = await actor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertFalse(fresh)
    let result = await actor.sharedDecode(asset: asset, target: image.extent.size) { image, _ in
      image
    }
    XCTAssertNil(result)
    let empty = RenderActor(pipeline: ImageEditPipeline())
    await empty.seed(asset: asset, decoded: image, rawResolution: image.extent.size)
    let seeded = await empty.snapshot(forAsset: asset)
    XCTAssertNil(seeded.image)
    let accepted = await empty.seedIfUnpopulated(
      asset: asset, decoded: image, rawResolution: image.extent.size)
    XCTAssertFalse(accepted)
  }

  func testLateOriginalDecodeCannotPublishUnderNewRemovalRevision() async throws {
    let (raw, xml) = try stage()
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try XMPSerializer.serialize(model: .default, culling: CullingState())
      .write(to: sidecar, atomically: true, encoding: .utf8)
    let asset = AssetRef(url: raw)
    let actor = RenderActor(pipeline: ImageEditPipeline())
    let target = CGSize(width: 16, height: 8)
    let stale = await actor.sharedDecode(
      asset: asset, target: target, profile: .neutral, autoExposure: .off, quality: .full
    ) { image, _ in
      do {
        try xml.write(to: sidecar, atomically: true, encoding: .utf8)
      } catch {
        XCTFail("Could not publish the accepted removal during decode: \(error)")
      }
      return image
    }
    XCTAssertNil(stale)
    let populated = await actor._testDecodedCachePopulated(forAsset: asset)
    XCTAssertFalse(populated, "Old pixels cannot claim the current accepted stack")
    let next = await actor.sharedDecode(
      asset: asset, target: target, profile: .neutral, autoExposure: .off, quality: .full
    ) { image, _ in image }
    let image = try XCTUnwrap(next)
    let expectedResult = await ImageEditPipeline().decodeSceneLinearSized(
      asset: asset, targetSize: target, xmpPath: sidecar, quality: .full,
      profileOverride: .neutral, autoExposureOverride: .off)
    let expected = try XCTUnwrap(expectedResult)
    func bytes(_ image: CIImage) -> Data {
      var output = Data(count: 16 * 8 * 16)
      output.withUnsafeMutableBytes {
        CIContext().render(
          image, toBitmap: $0.baseAddress!, rowBytes: 16 * 16,
          bounds: image.extent, format: .RGBAf,
          colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!)
      }
      return output
    }
    XCTAssertEqual(bytes(image), bytes(expected.image))
    XCTAssertEqual(try Data(contentsOf: raw), try fixture("source", "dng"))
  }
}
