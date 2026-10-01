import CoreGraphics
import XCTest

@testable import MapleCore

final class MaskGroupTests: XCTestCase {
  private let radial = LocalMask.radial(
    center: MaskPoint(x: 0.5, y: 0.5),
    radii: MaskPoint(x: 0.25, y: 0.375), angle: 0, feather: 0.5, invert: false)
  private let linear = LocalMask.linear(
    start: MaskPoint(x: 0, y: 0.5),
    end: MaskPoint(x: 1, y: 0.5), feather: 1)

  private func group(_ combine: MaskCombine, opacity: Double = 1, inverted: Bool = false) throws
    -> LocalMask
  {
    .group(
      MaskGroup(
        components: [
          try XCTUnwrap(MaskComponent(mask: radial)),
          try XCTUnwrap(MaskComponent(mask: linear, combine: combine)),
        ], opacity: opacity, invert: inverted))
  }

  func testWeightsComposeBeforeOpacityAndInversion() throws {
    // At the centre both leaves weigh 1 and 0.5 respectively.
    XCTAssertEqual(MaskWeight.evaluate(try group(.add), x: 0.5, y: 0.5), 1)
    XCTAssertEqual(MaskWeight.evaluate(try group(.subtract), x: 0.5, y: 0.5), 0.5)
    XCTAssertEqual(MaskWeight.evaluate(try group(.intersect, opacity: 0.4), x: 0.5, y: 0.5), 0.2)
    XCTAssertEqual(
      MaskWeight.evaluate(try group(.subtract, opacity: 0.4, inverted: true), x: 0.5, y: 0.5), 0.2)
    XCTAssertEqual(
      MaskWeight.evaluate(.group(MaskGroup(components: [], invert: true)), x: 0.5, y: 0.5), 0)
    XCTAssertEqual(MaskWeight.evaluate(try group(.add, opacity: .nan), x: 0.5, y: 0.5), 0)
  }

  func testUnresolvedBitmapDoesNotWidenAnInvertedSubtractGroup() throws {
    let recipe = BitmapRecipe(
      person: 0, facialSkin: true, bodySkin: true, model: "", digest: "0123456789abcdef")
    let mask = LocalMask.group(
      MaskGroup(
        components: [
          try XCTUnwrap(MaskComponent(mask: .everywhere)),
          try XCTUnwrap(
            MaskComponent(
              mask: .bitmap(recipe: recipe, rasterId: 0), combine: .subtract, invert: true)),
        ], invert: true))
    XCTAssertEqual(MaskWeight.evaluate(mask, x: 0.5, y: 0.5), 0)
  }

  func testNestedGroupsAreRejectedByConstructionAndDecoding() throws {
    let nested = try group(.subtract)
    XCTAssertNil(MaskComponent(mask: nested))
    var component = try XCTUnwrap(MaskComponent(mask: radial))
    XCTAssertFalse(component.replaceMask(nested))
    XCTAssertEqual(component.mask, radial)
    let encoded = try JSONEncoder().encode(component)
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    object["mask"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(nested))
    XCTAssertThrowsError(
      try JSONDecoder().decode(
        MaskComponent.self,
        from: JSONSerialization.data(withJSONObject: object)))
  }

  func testFlatGroupKeepsOneLogicalLayerAndAllFollowingControls() throws {
    let grouped = LocalAdjustment(
      mask: try group(.subtract, opacity: 0.5), range: .skinTone,
      adjustments: PartialAdjustments(exposure: 1, hue: 20, texture: 35))
    let ordinary = LocalAdjustment(
      mask: .everywhere, adjustments: PartialAdjustments(exposure: 0.5))
    let flat = LocalAdjustmentFlat.toFlat([grouped, ordinary])
    XCTAssertEqual(flat.count, 4 * LocalMaskWire.layerFlatLen)
    XCTAssertEqual(flat[6], LocalMaskWire.kindGroup)
    XCTAssertEqual(flat[0], 2)
    XCTAssertEqual(flat[46], 6)  // radial + Add
    XCTAssertEqual(flat[86], 9)  // linear + Subtract
    let decoded = LocalAdjustmentFlat.fromFlat(flat, rasterDigests: [:])
    XCTAssertEqual(decoded.count, 2)
    XCTAssertEqual(decoded[0].mask, grouped.mask)
    XCTAssertEqual(decoded[0].adjustments, grouped.adjustments)
    XCTAssertEqual(decoded[1], ordinary)
    XCTAssertEqual(LocalAdjustmentFlat.toFlat(decoded), flat)
    var invalid = flat
    invalid[86] = 29
    XCTAssertEqual(LocalAdjustmentFlat.fromFlat(invalid, rasterDigests: [:]), [])
    invalid = flat
    invalid[0] = .nan
    XCTAssertEqual(LocalAdjustmentFlat.fromFlat(invalid, rasterDigests: [:]), [])
  }

  func testCompositionSurvivesCropAndStraightenRemapping() throws {
    let mask = try group(.subtract, opacity: 0.6, inverted: true)
    let affine = MaskAffine.cropToFullFrame(
      Crop(top: 0.1, left: 0.2, bottom: 0.8, right: 0.9, angle: 7),
      nativeSize: CGSize(width: 6000, height: 4000))
    let remapped = MaskRemap.remappedGeometry(
      [LocalAdjustment(mask: mask, adjustments: PartialAdjustments())],
      through: affine)[0].mask
    for y in stride(from: 0.0, through: 1.0, by: 0.1) {
      for x in stride(from: 0.0, through: 1.0, by: 0.1) {
        let source = affine.apply(MaskPoint(x: x, y: y))
        XCTAssertEqual(
          MaskWeight.evaluate(remapped, x: x, y: y),
          MaskWeight.evaluate(mask, x: source.x, y: source.y), accuracy: 1e-9)
      }
    }
  }

  func testActualLightroomGroupsRoundTripThroughTemporarySidecars() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<7 { root.deleteLastPathComponent() }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "mask-group-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    for operation in ["add", "subtract", "intersect"] {
      let fixture = root.appendingPathComponent(
        "test-fixtures/local-adjustments/lightroom-group-\(operation).xmp")
      let source = try String(contentsOf: fixture, encoding: .utf8)
      let (model, culling) = try XMPParser.parse(source)
      XCTAssertEqual(model.localAdjustments.count, 1)
      guard case .group(let group) = model.localAdjustments[0].mask else {
        return XCTFail("group missing")
      }
      XCTAssertEqual(group.components.count, 2)
      XCTAssertEqual(
        group.components[1].combine,
        operation == "add" ? .add : operation == "subtract" ? .subtract : .intersect)
      guard
        case .radial(let center, let radii, _, let feather, let invert) = group.components[0].mask
      else { return XCTFail("radial missing") }
      XCTAssertEqual(center, MaskPoint(x: 0.5, y: 0.5))
      XCTAssertEqual(radii.x, 0.3, accuracy: 1e-12)
      XCTAssertEqual(radii.y, 0.3, accuracy: 1e-12)
      XCTAssertEqual(feather, 0.5)
      XCTAssertFalse(invert)
      let sidecar = directory.appendingPathComponent("\(operation).xmp")
      try XMPSerializer.serialize(model: model, culling: culling).write(
        to: sidecar, atomically: true, encoding: .utf8)
      let saved = try String(contentsOf: sidecar, encoding: .utf8)
      XCTAssertTrue(saved.contains("crs:CorrectionName=\"Composition reference\""))
      XCTAssertTrue(saved.contains("crs:MaskName=\"Radial reference\""))
      XCTAssertEqual(try XMPParser.parse(saved).0.localAdjustments, model.localAdjustments)
    }
  }

  func testGroupActuallyReachesTheFFIRenderer() throws {
    let input = (0..<256).flatMap { _ -> [Float] in [0.25, 0.18, 0.12, 1] }
      .withUnsafeBufferPointer { Data(buffer: $0) }
    let params = PipelineRenderer.makeParams(from: AdjustmentModel())
    let baseline = try PipelineRenderer.applySceneLinearChain(
      inputBytes: input, width: 16, height: 16, params: params)
    let grouped = try PipelineRenderer.applySceneLinearChain(
      inputBytes: input, width: 16, height: 16, params: params,
      localAdjustments: [
        LocalAdjustment(mask: try group(.subtract), adjustments: PartialAdjustments(exposure: 2))
      ])
    XCTAssertNotEqual(grouped, baseline)
    // A full-opacity everywhere group is identical to its legacy leaf.
    let full = LocalMask.group(
      MaskGroup(components: [try XCTUnwrap(MaskComponent(mask: .everywhere))]))
    let leaf = try PipelineRenderer.applySceneLinearChain(
      inputBytes: input, width: 16, height: 16, params: params,
      localAdjustments: [
        LocalAdjustment(mask: .everywhere, adjustments: PartialAdjustments(exposure: 1))
      ])
    let composed = try PipelineRenderer.applySceneLinearChain(
      inputBytes: input, width: 16, height: 16, params: params,
      localAdjustments: [LocalAdjustment(mask: full, adjustments: PartialAdjustments(exposure: 1))])
    XCTAssertEqual(composed, leaf)
  }
}
