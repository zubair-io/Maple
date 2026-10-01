import XCTest

@testable import MapleCore

final class MaskGroupPassthroughTests: XCTestCase {
  private func fixture() throws -> String {
    let root = try MaskGroupFixture.root()
    return try String(
      contentsOf: root.appendingPathComponent(
        "lightroom-group-subtract.xmp"), encoding: .utf8)
  }
  private func save(_ model: AdjustmentModel, source: String) throws -> String {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "group-xml-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let sidecar = directory.appendingPathComponent("photo.xmp")
    try XMPSerializer.serialize(
      model: model, culling: CullingState(), passthrough: XMPParser.parsePassthrough(source)
    )
    .write(to: sidecar, atomically: true, encoding: .utf8)
    return try String(contentsOf: sidecar, encoding: .utf8)
  }

  func testUnsupportedComponentKeepsWholeGroupVerbatim() throws {
    let source = try fixture().replacingOccurrences(
      of: "crs:MaskBlendMode=\"1\"", with: "crs:MaskBlendMode=\"9\"")
    var model = try XMPParser.parse(source).0
    XCTAssertTrue(model.localAdjustments.isEmpty)
    model.exposure = 0.7
    let saved = try save(model, source: source)
    let group = try XCTUnwrap(
      XMPChildElementScanner.descriptionChildren(in: source)
        .first { $0.qName == "crs:MaskGroupBasedCorrections" }?.source)
    XCTAssertTrue(saved.contains(group))
    XCTAssertTrue(try XMPParser.parse(saved).0.localAdjustments.isEmpty)
  }

  func testUnsupportedShapesAndBooleanFlagsKeepWholeGroupVerbatim() throws {
    let original = try fixture()
    let variants = [
      ("crs:Midpoint=\"50\"", "crs:Midpoint=\"25\""),
      ("crs:Roundness=\"0\"", "crs:Roundness=\"20\""),
      ("crs:MaskInverted=\"false\"", "crs:MaskInverted=\"unknown\""),
      ("crs:Flipped=\"true\"", "crs:Flipped=\"unknown\""),
      ("crs:MaskActive=\"true\"", "crs:MaskActive=\"unknown\""),
      ("crs:CorrectionActive=\"true\"", "crs:CorrectionActive=\"unknown\""),
      (
        "crs:CorrectionActive=\"true\"",
        "crs:CorrectionActive=\"true\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:RangeKind=\"Future\""
      ),
      (
        "crs:CorrectionActive=\"true\"",
        "crs:CorrectionActive=\"true\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:RangeKind=\"Color\" papp:RangeHue=\"NaN\""
      ),
    ]
    for (from, to) in variants {
      let source = original.replacingOccurrences(of: from, with: to)
      var model = try XMPParser.parse(source).0
      XCTAssertTrue(model.localAdjustments.isEmpty, to)
      model.exposure = 0.7
      let saved = try save(model, source: source)
      let group = try XCTUnwrap(
        XMPChildElementScanner.descriptionChildren(in: source)
          .first { $0.qName == "crs:MaskGroupBasedCorrections" }?.source)
      XCTAssertTrue(saved.contains(group), to)
      XCTAssertTrue(try XMPParser.parse(saved).0.localAdjustments.isEmpty, to)
    }
  }

  func testForeignPinStaysInOrderWhenItsModeledNeighborIsDeleted() throws {
    let pin =
      "<rdf:li><rdf:Description crs:What=\"Correction\" crs:CorrectionName=\"Foreign pin\"><crs:CorrectionMasks><rdf:Seq><rdf:li crs:What=\"Mask/Image\" crs:MaskDigest=\"vendor-only\"/></rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li>"
    let original = try fixture()
    let position = try XCTUnwrap(original.range(of: "    </rdf:Seq>", options: .backwards))
    var source = original
    source.insert(contentsOf: pin, at: position.lowerBound)
    var model = try XMPParser.parse(source).0
    XCTAssertEqual(model.localAdjustments.count, 1)
    XCTAssertEqual(model.localAdjustments[0].xmpGroupSlot, 0)
    let saved = try save(model, source: source)
    XCTAssertTrue(saved.contains(pin))
    XCTAssertLessThan(
      try XCTUnwrap(saved.range(of: "Composition reference")).lowerBound,
      try XCTUnwrap(saved.range(of: "Foreign pin")).lowerBound)
    XCTAssertEqual(try XMPParser.parse(saved).0.localAdjustments, model.localAdjustments)
    model.localAdjustments = []
    let deleted = try save(model, source: source)
    XCTAssertTrue(deleted.contains(pin))
    XCTAssertFalse(deleted.contains("Composition reference"))
  }

  func testForeignComponentNodesAndAttributesStayWithTheirComponent() throws {
    let source = try fixture()
      .replacingOccurrences(
        of: "crs:CorrectionName=\"Composition reference\"",
        with:
          "crs:CorrectionName=\"Composition reference\" xmlns:vendor=\"urn:mask-vendor\" vendor:Note=\"a &amp; b\""
      )
      .replacingOccurrences(
        of: "crs:Version=\"2\"/>",
        with:
          "crs:Version=\"2\"><vendor:Hint\turl=\"https://vendor.example/hint\" value=\"keep\"/></rdf:li>"
      )
    var model = try XMPParser.parse(source).0
    guard case .group(var group) = model.localAdjustments.first?.mask else {
      return XCTFail("group missing")
    }
    group.components.removeLast()
    group.components[0].invert = true
    model.localAdjustments[0].mask = .group(group)
    let saved = try save(model, source: source)
    XCTAssertTrue(saved.contains("vendor:Note=\"a &amp; b\""))
    XCTAssertTrue(saved.contains("value=\"keep\""))
    XCTAssertTrue(saved.contains("url=\"https://vendor.example/hint\""))
    XCTAssertFalse(saved.contains("Linear Gradient 1"))
    XCTAssertEqual(try XMPParser.parse(saved).0.localAdjustments, model.localAdjustments)
  }

  func testNamespaceAliasesRemainEditableWithoutDuplicatingTheGroup() throws {
    let source = try fixture().replacingOccurrences(of: "crs:", with: "camera:")
      .replacingOccurrences(of: "xmlns:crs=", with: "xmlns:camera=")
      .replacingOccurrences(of: "rdf:", with: "graph:")
      .replacingOccurrences(of: "xmlns:rdf=", with: "xmlns:graph=")
    var model = try XMPParser.parse(source).0
    XCTAssertEqual(model.localAdjustments.count, 1)
    model.localAdjustments[0].adjustments.exposure = 0.6
    let saved = try save(model, source: source)
    XCTAssertEqual(try XMPParser.parse(saved).0.localAdjustments, model.localAdjustments)
    XCTAssertEqual(saved.components(separatedBy: "MaskGroupBasedCorrections>").count, 3)
  }

  func testForeignReservedPrefixCannotBecomeOwnedGeometry() throws {
    let source = try fixture().replacingOccurrences(
      of: "crs:Version=\"2\"/>",
      with:
        "crs:Version=\"2\" xmlns:papp=\"urn:foreign\" xmlns:maskmeta=\"urn:occupied\" papp:MaskCombine=\"keep\" maskmeta:Note=\"reserved\"/>"
    )
    var model = try XMPParser.parse(source).0
    XCTAssertEqual(model.localAdjustments.count, 1)
    model.localAdjustments[0].adjustments.exposure = 0.7
    let saved = try save(model, source: source)
    XCTAssertTrue(saved.contains("xmlns:maskmeta1=\"urn:foreign\""))
    XCTAssertTrue(saved.contains("maskmeta1:MaskCombine=\"keep\""))
    XCTAssertTrue(saved.contains("maskmeta:Note=\"reserved\""))
    XCTAssertEqual(try XMPParser.parse(saved).0.localAdjustments, model.localAdjustments)
  }

  func testForeignGeometryNamespacePreservesTheCompleteGroup() throws {
    let source = try fixture().replacingOccurrences(
      of: "crs:Version=\"2\"/>", with: "crs:Version=\"2\" xmlns:crs=\"urn:foreign\"/>")
    var model = try XMPParser.parse(source).0
    XCTAssertTrue(model.localAdjustments.isEmpty)
    model.exposure = 0.7
    let saved = try save(model, source: source)
    let group = try XCTUnwrap(
      XMPChildElementScanner.descriptionChildren(in: source)
        .first { $0.qName == "crs:MaskGroupBasedCorrections" }?.source)
    XCTAssertTrue(saved.contains(group))
    XCTAssertTrue(try XMPParser.parse(saved).0.localAdjustments.isEmpty)
  }

  func testForeignGroupContainerCannotBecomeAModeledGroupAfterSaving() throws {
    let source = try fixture().replacingOccurrences(
      of: "http://ns.adobe.com/camera-raw-settings/1.0/", with: "urn:foreign")
    var model = try XMPParser.parse(source).0
    XCTAssertTrue(model.localAdjustments.isEmpty)
    model.exposure = 0.7
    let saved = try save(model, source: source)
    XCTAssertTrue(saved.contains("<crs:MaskGroupBasedCorrections xmlns:crs=\"urn:foreign\""))
    XCTAssertTrue(try XMPParser.parse(saved).0.localAdjustments.isEmpty)
    XCTAssertEqual(try save(model, source: saved), saved)
  }
}
