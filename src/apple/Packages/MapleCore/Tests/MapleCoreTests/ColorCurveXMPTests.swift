import XCTest

@testable import MapleCore

private let canonicalIndent = "      "

// Byte-parity fixture: the same block is asserted in the Rust, TS and C# suites.
private let canonicalBlock = [
  "      <papp:ColorCurveHueVsSat>",
  "        <rdf:Seq>",
  "          <rdf:li>0, 128</rdf:li>",
  "          <rdf:li>85, 191</rdf:li>",
  "          <rdf:li>255, 128</rdf:li>",
  "        </rdf:Seq>",
  "      </papp:ColorCurveHueVsSat>",
].joined(separator: "\n")

private let canonicalPoints: [ToneCurvePoint] = [
  (x: 0.0, y: 128.0 / 255.0),
  (x: 85.0 / 255.0, y: 191.0 / 255.0),
  (x: 1.0, y: 128.0 / 255.0),
]

private let newKeys = [
  "papp:ColorCurveHueVsHue", "papp:ColorCurveHueVsSat", "papp:ColorCurveHueVsLuma",
  "papp:ColorCurveLumaVsSat", "papp:ColorCurveSatVsSat", "papp:ColorCurveSatVsLuma",
  "papp:ColorGradeBlending", "papp:ColorGradeShadowEdge", "papp:ColorGradeHighlightEdge",
  "papp:ToneCurveMode",
]

private func sidecar(_ children: String) -> String {
  [
    "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>",
    "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">",
    "  <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
    "    <rdf:Description",
    "      xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\"",
    "      xmlns:dc=\"http://purl.org/dc/elements/1.1/\"",
    "      xmlns:papp=\"http://ns.justmaple.app/1.0/\"",
    "      crs:Version=\"11.0\">",
    children,
    "    </rdf:Description>",
    "  </rdf:RDF>",
    "</x:xmpmeta>",
    "<?xpacket end=\"w\"?>",
  ].joined(separator: "\n")
}

private func editedModel() -> AdjustmentModel {
  var model = AdjustmentModel()
  model.colorCurveHueVsHue = ToneCurve(points: [
    (x: 0.0, y: 0.5), (x: 0.5, y: 0.75), (x: 1.0, y: 0.5),
  ])
  model.colorCurveHueVsSat = ToneCurve(points: canonicalPoints)
  model.colorCurveHueVsLuma = ToneCurve(points: [(x: 0.2, y: 0.4), (x: 0.6, y: 0.6)])
  model.colorCurveLumaVsSat = ToneCurve(points: [(x: 0.0, y: 0.5), (x: 1.0, y: 0.8)])
  model.colorCurveSatVsSat = ToneCurve(points: [(x: 0.0, y: 0.0), (x: 1.0, y: 0.9)])
  model.colorCurveSatVsLuma = ToneCurve(points: [(x: 0.1, y: 0.5), (x: 0.9, y: 0.3)])
  model.colorGradeBlending = 40
  model.colorGradeShadowEdge = 0.3
  model.colorGradeHighlightEdge = 0.7
  model.toneCurveMode = .ratioPreserving
  return model
}

final class ColorCurveXMPTests: XCTestCase {
  func testCanonicalBlockIsTheSerializationOfAHueVsSatCurve() {
    var model = AdjustmentModel()
    model.colorCurveHueVsSat = ToneCurve(points: canonicalPoints)
    XCTAssertEqual(
      XMPSerializer._buildToneCurvesBlock(model: model, indent: canonicalIndent), canonicalBlock)
  }

  func testCanonicalBlockParsesBackToTheSamePoints() throws {
    let (model, _) = try XMPParser.parse(sidecar(canonicalBlock))
    XCTAssertEqual(model.colorCurveHueVsSat.points.count, 3)
    for (got, want) in zip(model.colorCurveHueVsSat.points, canonicalPoints) {
      XCTAssertEqual(got.x, want.x, accuracy: 1e-9)
      XCTAssertEqual(got.y, want.y, accuracy: 1e-9)
    }
    XCTAssertTrue(model.colorCurveHueVsHue.isIdentity)
  }

  func testEveryNewFieldRoundTripsThroughAFullSidecar() throws {
    let model = editedModel()
    let xml = XMPSerializer.serialize(model: model, culling: CullingState())
    let (back, _) = try XMPParser.parse(xml)
    let pairs: [(String, ToneCurve, ToneCurve)] = [
      ("hue vs hue", back.colorCurveHueVsHue, model.colorCurveHueVsHue),
      ("hue vs sat", back.colorCurveHueVsSat, model.colorCurveHueVsSat),
      ("hue vs luma", back.colorCurveHueVsLuma, model.colorCurveHueVsLuma),
      ("luma vs sat", back.colorCurveLumaVsSat, model.colorCurveLumaVsSat),
      ("sat vs sat", back.colorCurveSatVsSat, model.colorCurveSatVsSat),
      ("sat vs luma", back.colorCurveSatVsLuma, model.colorCurveSatVsLuma),
    ]
    for (label, got, want) in pairs {
      XCTAssertEqual(got.points.count, want.points.count, label)
      for (g, w) in zip(got.points, want.points) {
        XCTAssertEqual(g.x, w.x, accuracy: 1.0 / 255.0, label)
        XCTAssertEqual(g.y, w.y, accuracy: 1.0 / 255.0, label)
      }
    }
    XCTAssertEqual(back.colorGradeBlending, 40)
    XCTAssertEqual(back.colorGradeShadowEdge, 0.3, accuracy: 1e-6)
    XCTAssertEqual(back.colorGradeHighlightEdge, 0.7, accuracy: 1e-6)
    XCTAssertEqual(back.toneCurveMode, .ratioPreserving)
  }

  func testADefaultModelSerializesNoneOfTheNewFields() {
    let xml = XMPSerializer.serialize(model: AdjustmentModel(), culling: CullingState())
    for key in newKeys {
      XCTAssertFalse(xml.contains(key), "\(key) must be omitted at its default")
    }
  }

  func testASidecarWrittenBeforeTheFieldsExistedParsesToTheDefaults() throws {
    var edited = AdjustmentModel()
    edited.brightness = 12
    let old = XMPSerializer.serialize(model: edited, culling: CullingState())
    let (model, _) = try XMPParser.parse(old)
    let defaults = AdjustmentModel()
    XCTAssertEqual(model.brightness, 12)
    XCTAssertTrue(model.colorCurveHueVsHue.isIdentity)
    XCTAssertTrue(model.colorCurveHueVsSat.isIdentity)
    XCTAssertTrue(model.colorCurveHueVsLuma.isIdentity)
    XCTAssertTrue(model.colorCurveLumaVsSat.isIdentity)
    XCTAssertTrue(model.colorCurveSatVsSat.isIdentity)
    XCTAssertTrue(model.colorCurveSatVsLuma.isIdentity)
    XCTAssertEqual(model.colorGradeBlending, defaults.colorGradeBlending)
    XCTAssertEqual(model.colorGradeShadowEdge, defaults.colorGradeShadowEdge)
    XCTAssertEqual(model.colorGradeHighlightEdge, defaults.colorGradeHighlightEdge)
    XCTAssertEqual(model.toneCurveMode, defaults.toneCurveMode)
  }

  func testASingleEditEmitsOnlyItsOwnNewKey() {
    var model = AdjustmentModel()
    model.colorGradeBlending = 40
    let xml = XMPSerializer.serialize(model: model, culling: CullingState())
    XCTAssertTrue(xml.contains("papp:ColorGradeBlending"))
    for key in newKeys where key != "papp:ColorGradeBlending" {
      XCTAssertFalse(xml.contains(key), "\(key) leaked into an unrelated edit")
    }
  }
}
