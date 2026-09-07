// MaskRangeXMPTests.swift — a panel-authored colour range (#362) lands on
// the sidecar as the exact `papp:Range*` wire (docs/xmp-canonical-format.md
// § Range refinement) and reads back as the same value: the eyedropper's
// seed is already quantised to the two decimals the writer emits, so the
// model after a pick IS what the sidecar says.

import XCTest

@testable import MapleCore

final class MaskRangeXMPTests: XCTestCase {
  private let indent = "      "

  private func layer(range: RangeRefinement?) -> LocalAdjustment {
    LocalAdjustment(
      mask: .linear(start: MaskPoint(x: 0.1, y: 0.2), end: MaskPoint(x: 0.9, y: 0.8), feather: 0.5),
      range: range, adjustments: PartialAdjustments(exposure: 0.5))
  }

  private func block(_ layer: LocalAdjustment) -> String {
    var model = AdjustmentModel()
    model.localAdjustments = [layer]
    return XMPSerializer._buildLocalAdjustmentsBlock(model: model, indent: indent)
  }

  func testSeededRangeSerialisesToTheExactWireAndReadsBack() throws {
    let seeded = RangeRefinement.coreDefault.seeded(
      with: MaskRangeSample(hueDeg: -123.45, chromaMin: 0.07, lMin: 0.31, lMax: 0.81))
    let xml = block(layer(range: seeded))
    for line in [
      "papp:RangeKind=\"Color\"",
      "papp:RangeHue=\"-123.45\"",
      "papp:RangeHueWidth=\"25\"",
      "papp:RangeChromaMin=\"0.07\"",
      "papp:RangeLMin=\"0.31\"",
      "papp:RangeLMax=\"0.81\"",
      "papp:RangeFeather=\"0.3\"",
    ] {
      XCTAssertTrue(xml.contains(line), "missing \(line) in\n\(xml)")
    }
    let (reopened, _) = try XMPParser.parse(sidecar(xml))
    XCTAssertEqual(reopened.localAdjustments, [layer(range: seeded)])
  }

  func testSliderEditedRangeRoundTrips() throws {
    let edited = RangeRefinement.coreDefault
      .with(.hueWidth, 12).with(.chromaMin, 0.11).with(.lMin, 0.2).with(.lMax, 0.7)
      .with(.feather, 0)
    let (reopened, _) = try XMPParser.parse(sidecar(block(layer(range: edited))))
    XCTAssertEqual(reopened.localAdjustments.first?.range, edited)
  }

  /// Disabling the range drops every `papp:Range*` attribute — the
  /// primary mask alone, byte-identical to a layer that never had one.
  func testDisabledRangeEmitsNoRangeAttributes() {
    let xml = block(layer(range: nil))
    XCTAssertFalse(xml.contains("papp:Range"))
    XCTAssertEqual(xml, block(layer(range: nil)))
  }

  private func sidecar(_ block: String) -> String {
    """
    <x:xmpmeta xmlns:x="adobe:ns:meta/">
     <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
        xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
        xmlns:papp="http://ns.justmaple.app/photo/1.0/">
    \(block)
      </rdf:Description>
     </rdf:RDF>
    </x:xmpmeta>
    """
  }
}
