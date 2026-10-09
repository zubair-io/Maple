// LocalAdjustmentOrderTests.swift — cross-container layer order (#4427):
// `papp:LayerOrder` keeps an interleaved stack in model order through the
// per-kind XMP containers. Every round trip goes through a real `.xmp` file.
//
// `canonicalOrderBlock` is the cross-language parity artifact: the same
// literal is `CANONICAL_ORDER_BLOCK` in raw-core's
// `tests_local_adjustments_order.rs`, and all writers must produce it
// byte-for-byte from the same radial-then-linear stack.

import XCTest

@testable import MapleCore

private let canonicalIndent = "      "

private func exposure(_ value: Double) -> PartialAdjustments {
  PartialAdjustments(exposure: value)
}

private func linear(_ adjustments: PartialAdjustments) -> LocalAdjustment {
  LocalAdjustment(
    mask: .linear(start: MaskPoint(x: 0.2, y: 0.3), end: MaskPoint(x: 0.8, y: 0.7), feather: 0.5),
    adjustments: adjustments)
}

private func radial(_ adjustments: PartialAdjustments) -> LocalAdjustment {
  LocalAdjustment(
    mask: .radial(
      center: MaskPoint(x: 0.5, y: 0.5), radii: MaskPoint(x: 0.25, y: 0.125), angle: 0,
      feather: 0.5, invert: false),
    adjustments: adjustments)
}

private func brush(_ adjustments: PartialAdjustments) -> LocalAdjustment {
  LocalAdjustment(
    mask: .brush(
      dabs: [
        BrushDab(
          center: MaskPoint(x: 0.25, y: 0.3), radius: 0.05, feather: 0.5, weight: 0.8, erase: false)
      ],
      digest: "0123456789abcdef", rasterId: 0),
    adjustments: adjustments)
}

private func bitmap(_ adjustments: PartialAdjustments) -> LocalAdjustment {
  LocalAdjustment(
    mask: .bitmap(
      recipe: BitmapRecipe(
        person: 0, facialSkin: true, bodySkin: false, model: "apple-vision-person-instance/1",
        digest: "a1b2c3d4e5f60718"),
      rasterId: 0),
    adjustments: adjustments)
}

private let interleavedStack = [
  brush(exposure(0.1)),
  radial(exposure(0.2)),
  bitmap(exposure(0.3)),
  linear(exposure(0.4)),
  radial(exposure(0.5)),
]

private let canonicalOrderBlock = """
        <crs:GradientBasedCorrections>
          <rdf:Seq>
            <rdf:li>
              <rdf:Description
                crs:What="Correction"
                crs:CorrectionAmount="1"
                crs:CorrectionActive="True"
                papp:LayerOrder="1"
                crs:LocalExposure2012="0.4">
                <crs:CorrectionMasks>
                  <rdf:Seq>
                    <rdf:li
                      crs:What="Mask/Gradient"
                      crs:MaskValue="1"
                      crs:ZeroX="0.2" crs:ZeroY="0.3"
                      crs:FullX="0.8" crs:FullY="0.7"
                      papp:LocalFeather="0.5"/>
                  </rdf:Seq>
                </crs:CorrectionMasks>
              </rdf:Description>
            </rdf:li>
          </rdf:Seq>
        </crs:GradientBasedCorrections>
        <crs:CircularGradientBasedCorrections>
          <rdf:Seq>
            <rdf:li>
              <rdf:Description
                crs:What="Correction"
                crs:CorrectionAmount="1"
                crs:CorrectionActive="True"
                papp:LayerOrder="0"
                crs:LocalExposure2012="0.2">
                <crs:CorrectionMasks>
                  <rdf:Seq>
                    <rdf:li
                      crs:What="Mask/CircularGradient"
                      crs:MaskValue="1"
                      crs:Top="0.375" crs:Left="0.25" crs:Bottom="0.625" crs:Right="0.75"
                      crs:Angle="0" crs:Midpoint="50" crs:Roundness="0"
                      crs:Feather="50" crs:Flipped="False"/>
                  </rdf:Seq>
                </crs:CorrectionMasks>
              </rdf:Description>
            </rdf:li>
          </rdf:Seq>
        </crs:CircularGradientBasedCorrections>
  """

/// `BRUSH_V2_BLOCK` / `PASSTHROUGH_ORDER_BLOCK` in raw-core: a stroke this
/// build cannot read (`papp:BrushVersion="2"`) is kept verbatim between two
/// modeled layers, and new layers are keyed around it without touching it.
private let brushV2Block = """
        <papp:BrushCorrections>
          <rdf:Seq>
            <rdf:li>
              <rdf:Description
                crs:What="Correction"
                crs:CorrectionAmount="1"
                crs:CorrectionActive="True"
                papp:LayerOrder="1"
                crs:LocalExposure2012="0.3">
                <crs:CorrectionMasks>
                  <rdf:Seq>
                    <rdf:li
                      crs:What="Mask/Paint"
                      crs:MaskValue="1"
                      papp:BrushVersion="2"
                      papp:Dabs="0.25 0.3 0.05 0.5 0.8 0"/>
                  </rdf:Seq>
                </crs:CorrectionMasks>
              </rdf:Description>
            </rdf:li>
          </rdf:Seq>
        </papp:BrushCorrections>
  """

private let passthroughOrderBlock = """
        <crs:GradientBasedCorrections>
          <rdf:Seq>
            <rdf:li>
              <rdf:Description
                crs:What="Correction"
                crs:CorrectionAmount="1"
                crs:CorrectionActive="True"
                papp:LayerOrder="-1"
                crs:LocalExposure2012="0.1">
                <crs:CorrectionMasks>
                  <rdf:Seq>
                    <rdf:li
                      crs:What="Mask/Gradient"
                      crs:MaskValue="1"
                      crs:ZeroX="0.2" crs:ZeroY="0.3"
                      crs:FullX="0.8" crs:FullY="0.7"
                      papp:LocalFeather="0.5"/>
                  </rdf:Seq>
                </crs:CorrectionMasks>
              </rdf:Description>
            </rdf:li>
            <rdf:li>
              <rdf:Description
                crs:What="Correction"
                crs:CorrectionAmount="1"
                crs:CorrectionActive="True"
                papp:LayerOrder="0"
                crs:LocalExposure2012="0.4">
                <crs:CorrectionMasks>
                  <rdf:Seq>
                    <rdf:li
                      crs:What="Mask/Gradient"
                      crs:MaskValue="1"
                      crs:ZeroX="0.2" crs:ZeroY="0.3"
                      crs:FullX="0.8" crs:FullY="0.7"
                      papp:LocalFeather="0.5"/>
                  </rdf:Seq>
                </crs:CorrectionMasks>
              </rdf:Description>
            </rdf:li>
          </rdf:Seq>
        </crs:GradientBasedCorrections>
        <crs:CircularGradientBasedCorrections>
          <rdf:Seq>
            <rdf:li>
              <rdf:Description
                crs:What="Correction"
                crs:CorrectionAmount="1"
                crs:CorrectionActive="True"
                papp:LayerOrder="2"
                crs:LocalExposure2012="0.2">
                <crs:CorrectionMasks>
                  <rdf:Seq>
                    <rdf:li
                      crs:What="Mask/CircularGradient"
                      crs:MaskValue="1"
                      crs:Top="0.375" crs:Left="0.25" crs:Bottom="0.625" crs:Right="0.75"
                      crs:Angle="0" crs:Midpoint="50" crs:Roundness="0"
                      crs:Feather="50" crs:Flipped="False"/>
                  </rdf:Seq>
                </crs:CorrectionMasks>
              </rdf:Description>
            </rdf:li>
          </rdf:Seq>
        </crs:CircularGradientBasedCorrections>
  """

final class LocalAdjustmentOrderTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "layer-order-\(UUID())")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try FileManager.default.removeItem(at: directory)
  }

  private func model(_ layers: [LocalAdjustment]) -> AdjustmentModel {
    var model = AdjustmentModel()
    model.localAdjustments = layers
    return model
  }

  private func roundTrip(_ text: String, name: String = "photo.xmp") throws -> String {
    let sidecar = directory.appendingPathComponent(name)
    try text.write(to: sidecar, atomically: true, encoding: .utf8)
    return try String(contentsOf: sidecar, encoding: .utf8)
  }

  private func save(_ model: AdjustmentModel, source: String? = nil) throws -> String {
    try roundTrip(
      XMPSerializer.serialize(
        model: model, culling: CullingState(),
        passthrough: source.map(XMPParser.parsePassthrough) ?? .empty))
  }

  private func savedInterleaved() throws -> String {
    try save(model(interleavedStack))
  }

  func testInterleavedStackSurvivesSaveReopenSave() throws {
    let first = try savedInterleaved()
    XCTAssertEqual(first.components(separatedBy: "papp:LayerOrder=").count - 1, 5, first)

    let reopened = try XMPParser.parse(first).0
    XCTAssertEqual(reopened.localAdjustments, interleavedStack)

    let second = try save(reopened, source: first)
    XCTAssertEqual(second, first)
  }

  func testInterleavedPairMatchesTheCrossLanguageLiteral() throws {
    let pair = model([radial(exposure(0.2)), linear(exposure(0.4))])
    XCTAssertEqual(
      XMPSerializer._buildLocalAdjustmentsBlock(model: pair, indent: canonicalIndent),
      canonicalOrderBlock)

    let saved = try save(pair)
    XCTAssertTrue(saved.contains(canonicalOrderBlock), saved)
    XCTAssertEqual(try XMPParser.parse(saved).0.localAdjustments, pair.localAdjustments)
  }

  func testStackAlreadyInContainerOrderWritesNoKeys() throws {
    let ordered = [
      linear(exposure(0.4)), radial(exposure(0.2)), brush(exposure(0.1)), bitmap(exposure(0.3)),
    ]
    let saved = try save(model(ordered))
    XCTAssertFalse(saved.contains(LocalMaskWire.layerOrderAttribute), saved)
    XCTAssertEqual(try XMPParser.parse(saved).0.localAdjustments, ordered)
  }

  func testUnkeyedSidecarLoadsInContainerOrderAndResavesByteIdentically() throws {
    let unkeyed = try roundTrip(
      savedInterleaved().components(separatedBy: "\n")
        .filter { !$0.contains("papp:LayerOrder=") }
        .joined(separator: "\n"),
      name: "unkeyed.xmp")

    let reopened = try XMPParser.parse(unkeyed).0
    XCTAssertEqual(
      reopened.localAdjustments,
      [
        linear(exposure(0.4)), radial(exposure(0.2)), radial(exposure(0.5)),
        brush(exposure(0.1)), bitmap(exposure(0.3)),
      ])
    XCTAssertEqual(try save(reopened, source: unkeyed), unkeyed)
  }

  func testPartiallyKeyedSidecarLoadsInContainerOrder() throws {
    let saved = try save(model([radial(exposure(0.2)), linear(exposure(0.4))]))
    let keyLine = "              papp:LayerOrder=\"1\"\n"
    let partial = try roundTrip(
      saved.replacingOccurrences(of: keyLine, with: ""), name: "partial.xmp")
    XCTAssertNotEqual(partial, saved)
    XCTAssertEqual(
      try XMPParser.parse(partial).0.localAdjustments,
      [linear(exposure(0.4)), radial(exposure(0.2))])
  }

  func testMalformedKeyReadsAsAbsent() throws {
    let saved = try save(model([radial(exposure(0.2)), linear(exposure(0.4))]))
    let corrupt = try roundTrip(
      saved.replacingOccurrences(of: "papp:LayerOrder=\"1\"", with: "papp:LayerOrder=\"-1\""),
      name: "corrupt.xmp")
    XCTAssertEqual(
      try XMPParser.parse(corrupt).0.localAdjustments,
      [linear(exposure(0.4)), radial(exposure(0.2))])
  }

  /// A group correction re-emitted through a host group template (an
  /// opaque foreign neighbour keeps the container verbatim) carries its key
  /// too, and the key is owned — never kept as foreign metadata.
  func testTemplatedGroupCorrectionCarriesItsKey() throws {
    let pin =
      "<rdf:li><rdf:Description crs:What=\"Correction\" crs:CorrectionName=\"Foreign pin\"><crs:CorrectionMasks><rdf:Seq><rdf:li crs:What=\"Mask/Image\" crs:MaskDigest=\"vendor-only\"/></rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li>"
    let plain = try save(model([bitmap(exposure(0.3))]))
    let close = try XCTUnwrap(plain.range(of: "        </rdf:Seq>", options: .backwards))
    var source = plain
    source.insert(contentsOf: pin, at: close.lowerBound)
    var edited = try XMPParser.parse(source).0
    XCTAssertEqual(edited.localAdjustments.map(\.xmpGroupSlot), [0])
    edited.localAdjustments.append(linear(exposure(0.4)))

    let saved = try save(edited, source: source)
    XCTAssertTrue(saved.contains(pin), saved)
    XCTAssertEqual(saved.components(separatedBy: "papp:LayerOrder=\"0\"").count - 1, 1, saved)
    XCTAssertEqual(saved.components(separatedBy: "papp:LayerOrder=\"1\"").count - 1, 1, saved)

    let reopened = try XMPParser.parse(saved).0
    XCTAssertEqual(reopened.localAdjustments, edited.localAdjustments)
    XCTAssertNil(reopened.localAdjustments[0].xmpMetadata)
    XCTAssertEqual(try save(reopened, source: saved), saved)
  }

  private func verbatimSidecar() throws -> String {
    let saved = try save(model([radial(exposure(0.2)), linear(exposure(0.4))]))
    let keyed =
      canonicalOrderBlock
      .replacingOccurrences(of: "papp:LayerOrder=\"0\"", with: "papp:LayerOrder=\"2\"")
      .replacingOccurrences(of: "papp:LayerOrder=\"1\"", with: "papp:LayerOrder=\"0\"")
    return try roundTrip(
      saved.replacingOccurrences(of: canonicalOrderBlock, with: keyed + "\n" + brushV2Block),
      name: "verbatim.xmp")
  }

  private func keyed(_ layer: LocalAdjustment, _ key: Double) -> LocalAdjustment {
    var layer = layer
    layer.xmpLayerOrder = key
    return layer
  }

  func testNewBottomLayerIsKeyedBelowTheVerbatimStrokeWithoutTouchingIt() throws {
    let source = try verbatimSidecar()
    var loaded = try XMPParser.parse(source).0
    XCTAssertEqual(
      loaded.localAdjustments, [keyed(linear(exposure(0.4)), 0), keyed(radial(exposure(0.2)), 2)])
    loaded.localAdjustments.insert(linear(exposure(0.1)), at: 0)

    let saved = try save(loaded, source: source)
    XCTAssertTrue(saved.contains(passthroughOrderBlock + "\n" + brushV2Block), saved)

    let reopened = try XMPParser.parse(saved).0
    XCTAssertEqual(
      reopened.localAdjustments,
      [
        keyed(linear(exposure(0.1)), -1), keyed(linear(exposure(0.4)), 0),
        keyed(radial(exposure(0.2)), 2),
      ])
    XCTAssertEqual(try save(reopened, source: saved), saved)
  }

  /// The in-memory model keeps the keys it was read with; a second save
  /// against the first save's bytes must not move anything.
  func testSavingTwiceWithoutReopeningIsAFixedPoint() throws {
    let source = try verbatimSidecar()
    var loaded = try XMPParser.parse(source).0
    loaded.localAdjustments.insert(linear(exposure(0.1)), at: 0)

    let first = try save(loaded, source: source)
    XCTAssertEqual(try save(loaded, source: first), first)
  }

  func testDeletingALayerLeavesEveryOtherKeyInPlace() throws {
    let source = try verbatimSidecar()
    var loaded = try XMPParser.parse(source).0
    loaded.localAdjustments.removeFirst()

    let saved = try save(loaded, source: source)
    XCTAssertTrue(saved.contains(brushV2Block), saved)
    XCTAssertTrue(saved.contains("papp:LayerOrder=\"2\""), saved)
    XCTAssertFalse(saved.contains("papp:LayerOrder=\"0\""), saved)

    let reopened = try XMPParser.parse(saved).0
    XCTAssertEqual(reopened.localAdjustments, [keyed(radial(exposure(0.2)), 2)])
    XCTAssertEqual(try save(reopened, source: saved), saved)
  }

  /// An opaque group-template correction keeps its key byte-for-byte; the
  /// modeled layers are keyed around it.
  func testKeyedOpaqueGroupCorrectionIsNeverRewritten() throws {
    let pin =
      "<rdf:li><rdf:Description crs:What=\"Correction\" papp:LayerOrder=\"1\" crs:CorrectionName=\"Foreign pin\"><crs:CorrectionMasks><rdf:Seq><rdf:li crs:What=\"Mask/Image\" crs:MaskDigest=\"vendor-only\"/></rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li>"
    let plain = try save(model([bitmap(exposure(0.3))]))
    let close = try XCTUnwrap(plain.range(of: "        </rdf:Seq>", options: .backwards))
    var source = plain
    source.insert(contentsOf: pin, at: close.lowerBound)
    var edited = try XMPParser.parse(source).0
    XCTAssertEqual(edited.localAdjustments.map(\.xmpLayerOrder), [nil])
    edited.localAdjustments.append(linear(exposure(0.4)))

    let saved = try save(edited, source: source)
    XCTAssertTrue(saved.contains(pin), saved)
    let reopened = try XMPParser.parse(saved).0
    XCTAssertEqual(reopened.localAdjustments.map(\.xmpLayerOrder), [0, 0.5])
    XCTAssertEqual(try save(reopened, source: saved), saved)
    XCTAssertEqual(try save(edited, source: saved), saved)
  }

  /// Read keys [2, 0] tie on run length; the later layer keeps its key and
  /// the earlier one is re-keyed below it.
  func testLongestRunTieKeepsTheLaterLayer() {
    let stroke = brushV2Block.trimmingCharacters(in: .whitespaces)
    let keys = LocalAdjustmentOrder.keyed(
      [keyed(radial(exposure(0.2)), 2), keyed(linear(exposure(0.4)), 0)],
      around: XMPPassthrough(unknownNodes: [stroke])
    ).map(\.key)
    XCTAssertEqual(keys, [-1, 0])
  }
}
