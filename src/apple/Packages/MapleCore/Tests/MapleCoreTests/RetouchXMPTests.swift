// RetouchXMPTests.swift — `crs:RetouchAreas` round trips (#3409).
//
// `canonicalBlock` is the cross-language parity artifact: the same literal
// appears in the Rust suite (`raw-core/src/xmp/tests_retouch.rs`), the
// TypeScript suite (`retouch.spec.ts`) and the C# suite
// (`XmpRetouchTests.cs`), and every writer that models the block must
// produce it byte for byte from `canonicalSpots()`.

import XCTest

@testable import MapleCore

final class RetouchXMPTests: XCTestCase {
    /// Six spaces — the canonical `rdf:Description` child indent.
    private let indent = "      "

    /// Mirrored by `canonical_spots()` in Rust and `canonicalSpots()` in TS.
    private func canonicalSpots() -> [RetouchSpot] {
        [
            RetouchSpot(
                kind: .heal,
                center: RetouchPoint(x: 0.25, y: 0.5),
                source: RetouchPoint(x: 0.75, y: 0.5),
                radius: 0.05, feather: 0.5, opacity: 1),
            RetouchSpot(
                kind: .clone,
                center: RetouchPoint(x: 0.8, y: 0.2),
                source: RetouchPoint(x: 0.6, y: 0.3),
                radius: 0.0125, feather: 0, opacity: 0.75),
        ]
    }

    private let canonicalBlock = """
              <crs:RetouchAreas>
                <rdf:Seq>
                  <rdf:li>
                    <rdf:Description
                      crs:SpotType="heal"
                      crs:SourceState="sourceSetExplicitly"
                      crs:Method="circle"
                      crs:SourceX="0.750000"
                      crs:SourceY="0.500000"
                      crs:Opacity="1.000000"
                      crs:Feather="0.500000"
                      crs:Seed="0">
                      <crs:Masks>
                        <rdf:Seq>
                          <rdf:li
                            crs:What="Mask/CircularGradient"
                            crs:MaskValue="1"
                            crs:X="0.250000"
                            crs:Y="0.500000"
                            crs:Radius="0.050000"
                            crs:Flow="1"
                            crs:CenterWeight="0"/>
                        </rdf:Seq>
                      </crs:Masks>
                    </rdf:Description>
                  </rdf:li>
                  <rdf:li>
                    <rdf:Description
                      crs:SpotType="clone"
                      crs:SourceState="sourceSetExplicitly"
                      crs:Method="circle"
                      crs:SourceX="0.600000"
                      crs:SourceY="0.300000"
                      crs:Opacity="0.750000"
                      crs:Feather="0.000000"
                      crs:Seed="0">
                      <crs:Masks>
                        <rdf:Seq>
                          <rdf:li
                            crs:What="Mask/CircularGradient"
                            crs:MaskValue="1"
                            crs:X="0.800000"
                            crs:Y="0.200000"
                            crs:Radius="0.012500"
                            crs:Flow="1"
                            crs:CenterWeight="0"/>
                        </rdf:Seq>
                      </crs:Masks>
                    </rdf:Description>
                  </rdf:li>
                </rdf:Seq>
              </crs:RetouchAreas>
        """

    /// Wrap a child block in the minimum envelope the parser accepts.
    private func document(_ children: String) -> String {
        """
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
          <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
            <rdf:Description rdf:about=""
              xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              crs:Version="11.0">
        \(children)
            </rdf:Description>
          </rdf:RDF>
        </x:xmpmeta>
        """
    }

    func testDefaultModelEmitsNothing() {
        XCTAssertEqual(
            XMPSerializer._buildRetouchAreasBlock(model: .default, indent: indent), "")
    }

    func testSerializesTheCanonicalBlockByteForByte() {
        var m = AdjustmentModel.default
        m.retouchSpots = canonicalSpots()
        XCTAssertEqual(
            XMPSerializer._buildRetouchAreasBlock(model: m, indent: indent), canonicalBlock)
    }

    func testRoundTripsTheCanonicalBlock() throws {
        let (model, _) = try XMPParser.parse(document(canonicalBlock))
        XCTAssertEqual(model.retouchSpots, canonicalSpots())
        XCTAssertEqual(
            XMPSerializer._buildRetouchAreasBlock(model: model, indent: indent), canonicalBlock)
    }

    func testADocumentWithoutSpotsParsesToAnEmptyList() throws {
        let (model, _) = try XMPParser.parse(document(""))
        XCTAssertTrue(model.retouchSpots.isEmpty)
    }

    /// The container is modeled, so it must never ALSO ride the passthrough
    /// bucket — that would emit it twice on the next save.
    func testTheContainerIsWrittenExactlyOnceThroughAFullRoundTrip() throws {
        let source = document(canonicalBlock)
        let (model, culling) = try XMPParser.parse(source)
        let passthrough = XMPParser.parsePassthrough(source)
        let resaved = XMPSerializer.serialize(
            model: model, culling: culling, omitWhiteBalance: true, passthrough: passthrough)
        XCTAssertEqual(resaved.components(separatedBy: "<crs:RetouchAreas>").count - 1, 1)
        XCTAssertTrue(resaved.contains("crs:SpotType=\"clone\""))
    }

    func testImportsASpotWhoseSourceIsEncodedAsAnOffset() throws {
        let block = """
                  <crs:RetouchAreas>
                    <rdf:Seq>
                      <rdf:li>
                        <rdf:Description crs:SpotType="heal" crs:SourceState="sourceAutoComputed"
                          crs:OffsetX="0.100000" crs:OffsetY="-0.050000" crs:Feather="0.250000">
                          <crs:Masks>
                            <rdf:Seq>
                              <rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1"
                                crs:X="0.400000" crs:Y="0.600000" crs:Radius="0.030000"/>
                            </rdf:Seq>
                          </crs:Masks>
                        </rdf:Description>
                      </rdf:li>
                    </rdf:Seq>
                  </crs:RetouchAreas>
            """
        let (model, _) = try XMPParser.parse(document(block))
        XCTAssertEqual(model.retouchSpots.count, 1)
        XCTAssertEqual(model.retouchSpots[0].source.x, 0.5, accuracy: 1e-9)
        XCTAssertEqual(model.retouchSpots[0].source.y, 0.55, accuracy: 1e-9)
        XCTAssertEqual(model.retouchSpots[0].feather, 0.25, accuracy: 1e-9)
    }

    func testDropsACorrectionWhoseMaskIsNotTheCircularForm() throws {
        let block = """
                  <crs:RetouchAreas>
                    <rdf:Seq>
                      <rdf:li>
                        <rdf:Description crs:SpotType="heal" crs:SourceX="0.1" crs:SourceY="0.1">
                          <crs:Masks>
                            <rdf:Seq>
                              <rdf:li crs:What="Mask/Paint" crs:MaskValue="1" crs:Radius="0.02"/>
                            </rdf:Seq>
                          </crs:Masks>
                        </rdf:Description>
                      </rdf:li>
                    </rdf:Seq>
                  </crs:RetouchAreas>
            """
        let (model, _) = try XMPParser.parse(document(block))
        XCTAssertTrue(model.retouchSpots.isEmpty)
    }

    func testReadsTheLegacyRetouchInfoStringForm() throws {
        let block = """
                  <crs:RetouchInfo>
                    <rdf:Seq>
                      <rdf:li>centerX = 0.5, centerY = 0.5, radius = 0.02, sourceState = sourceSetExplicitly, sourceX = 0.6, sourceY = 0.5, spotType = heal</rdf:li>
                      <rdf:li>centerX = 0.1, centerY = 0.2, radius = 0.01, sourceState = sourceSetExplicitly, sourceX = 0.3, sourceY = 0.4, spotType = clone</rdf:li>
                    </rdf:Seq>
                  </crs:RetouchInfo>
            """
        let (model, _) = try XMPParser.parse(document(block))
        XCTAssertEqual(model.retouchSpots.count, 2)
        XCTAssertEqual(model.retouchSpots[0].kind, .heal)
        XCTAssertEqual(model.retouchSpots[0].radius, 0.02, accuracy: 1e-9)
        XCTAssertEqual(model.retouchSpots[1].kind, .clone)
        XCTAssertEqual(model.retouchSpots[1].source.x, 0.3, accuracy: 1e-9)
    }

    func testTheStructFormWinsOverTheLegacyStrings() throws {
        let legacy = """
                  <crs:RetouchInfo>
                    <rdf:Seq>
                      <rdf:li>centerX = 0.9, centerY = 0.9, radius = 0.5, sourceState = sourceSetExplicitly, sourceX = 0.1, sourceY = 0.1, spotType = clone</rdf:li>
                    </rdf:Seq>
                  </crs:RetouchInfo>
            """
        let (model, _) = try XMPParser.parse(document("\(legacy)\n\(canonicalBlock)"))
        XCTAssertEqual(model.retouchSpots, canonicalSpots())
    }
}
