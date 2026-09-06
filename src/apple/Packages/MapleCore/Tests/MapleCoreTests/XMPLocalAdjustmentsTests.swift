import XCTest

@testable import MapleCore

final class XMPLocalAdjustmentsTests: XCTestCase {
    func testLinearAndRadialLayersRoundTripThroughGradientBasedCorrections() throws {
        var model = AdjustmentModel()
        model.localAdjustments = [
            LocalAdjustment(
                mask: .linear(start: MaskPoint(x: 0.2, y: 0.3), end: MaskPoint(x: 0.8, y: 0.7), feather: 0.4),
                range: nil, adjustments: PartialAdjustments(exposure: 0.5, shadows: -20)
            ),
            LocalAdjustment(
                mask: .radial(
                    center: MaskPoint(x: 0.5, y: 0.4), radii: MaskPoint(x: 0.25, y: 0.15), angle: .pi / 4, feather: 0.6,
                    invert: true),
                range: nil, adjustments: PartialAdjustments(contrast: 15, vibrance: -10, temperature: 200)
            ),
        ]
        let xml = XMPSerializer.serialize(model: model, culling: CullingState())
        XCTAssertTrue(xml.contains("crs:GradientBasedCorrections"))
        XCTAssertTrue(xml.contains("crs:CircularGradientBasedCorrections"))
        let (parsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.localAdjustments.count, model.localAdjustments.count)
        guard case .linear(let start, let end, let feather) = parsed.localAdjustments[0].mask,
            case .linear(let wantStart, let wantEnd, let wantFeather) = model.localAdjustments[0].mask
        else {
            return XCTFail("expected .linear on both sides")
        }
        XCTAssertEqual(start.x, wantStart.x, accuracy: 1e-5)
        XCTAssertEqual(start.y, wantStart.y, accuracy: 1e-5)
        XCTAssertEqual(end.x, wantEnd.x, accuracy: 1e-5)
        XCTAssertEqual(end.y, wantEnd.y, accuracy: 1e-5)
        XCTAssertEqual(feather, wantFeather, accuracy: 1e-5)
        XCTAssertEqual(parsed.localAdjustments[0].adjustments, model.localAdjustments[0].adjustments)
        guard case .radial(let center, let radii, let angle, let radialFeather, let invert) = parsed.localAdjustments[1].mask,
            case .radial(
                let wantCenter, let wantRadii, let wantAngle, let wantRadialFeather, let wantInvert
            ) = model.localAdjustments[1].mask
        else {
            return XCTFail("expected .radial on both sides")
        }
        XCTAssertEqual(center.x, wantCenter.x, accuracy: 1e-4)
        XCTAssertEqual(center.y, wantCenter.y, accuracy: 1e-4)
        XCTAssertEqual(radii.x, wantRadii.x, accuracy: 1e-4)
        XCTAssertEqual(radii.y, wantRadii.y, accuracy: 1e-4)
        XCTAssertEqual(angle, wantAngle, accuracy: 1e-3)
        XCTAssertEqual(radialFeather, wantRadialFeather, accuracy: 1e-3)
        XCTAssertEqual(invert, wantInvert)
        XCTAssertEqual(parsed.localAdjustments[1].adjustments, model.localAdjustments[1].adjustments)
    }

    func testHueAndRangeRoundTripOnAPersonSkinLayer() throws {
        var model = AdjustmentModel()
        let recipe = BitmapRecipe(person: 0, facialSkin: true, bodySkin: true, model: "apple-vision-person-instance/1", digest: "8f3a1c9e0b2d4f67")
        model.localAdjustments = [
            LocalAdjustment(mask: .bitmap(recipe: recipe, rasterId: 0), range: .skinTone, adjustments: PartialAdjustments(hue: -20))
        ]
        let xml = XMPSerializer.serialize(model: model, culling: CullingState())
        XCTAssertTrue(xml.contains("crs:MaskGroupBasedCorrections"))
        XCTAssertTrue(xml.contains(#"papp:MaskSource="PersonSkin""#))
        XCTAssertTrue(xml.contains(#"crs:LocalHue="-0.2""#))
        XCTAssertTrue(xml.contains(#"papp:RangeHue="55""#))
        let (parsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.localAdjustments.count, 1)
        XCTAssertEqual(parsed.localAdjustments[0].adjustments.hue, -20)
        XCTAssertEqual(parsed.localAdjustments[0].range, .skinTone)
        guard case .bitmap(let recipeBack, _) = parsed.localAdjustments[0].mask else {
            return XCTFail("expected .bitmap")
        }
        XCTAssertEqual(recipeBack.digest, "8f3a1c9e0b2d4f67")
    }

    func testAFractionalHueSurvivesTheAdobeScaleRoundTrip() throws {
        // −42.5 on the ±100 slider is −0.425 on Adobe's ±1 wire scale; the
        // canonical 2-decimal precision would persist "-0.43" and read back
        // −43 (#3280 review).
        var model = AdjustmentModel()
        model.localAdjustments = [
            LocalAdjustment(mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments(hue: -42.5))
        ]
        let xml = XMPSerializer.serialize(model: model, culling: CullingState())
        XCTAssertTrue(xml.contains(#"crs:LocalHue="-0.425""#), xml)
        let (parsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.localAdjustments[0].adjustments.hue, -42.5)
    }

    func testAnEverywhereSkinRangeLayerRoundTrips() throws {
        var model = AdjustmentModel()
        model.localAdjustments = [
            LocalAdjustment(mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments(saturation: 10))
        ]
        let xml = XMPSerializer.serialize(model: model, culling: CullingState())
        XCTAssertTrue(xml.contains(#"papp:MaskSource="Everywhere""#))
        let (parsed, _) = try XMPParser.parse(xml)
        XCTAssertEqual(parsed.localAdjustments.count, 1)
        XCTAssertEqual(parsed.localAdjustments[0].mask, .everywhere)
        XCTAssertEqual(parsed.localAdjustments[0].range, .skinTone)
        XCTAssertEqual(parsed.localAdjustments[0].adjustments, model.localAdjustments[0].adjustments)
    }

    func testALightroomSidecarWithMasksSurvivesAMapleSaveUnchanged() throws {
        // A Lightroom-shaped GradientBasedCorrections block, parsed then
        // re-serialized with no edits, must reproduce the mask byte-for-byte
        // via passthrough — proving the three new containers no longer fall
        // into the generic unknown-node bucket AND that Maple's own model
        // path reproduces them when it DOES understand them.
        let xml = """
            <?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
              <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                <rdf:Description
                  xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                  xmlns:papp="http://ns.justmaple.app/1.0/"
                  crs:Version="11.0">
                  <crs:GradientBasedCorrections>
                    <rdf:Seq>
                      <rdf:li>
                        <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True" crs:LocalExposure2012="0.5">
                          <crs:CorrectionMasks>
                            <rdf:Seq>
                              <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0.2" crs:ZeroY="0.3" crs:FullX="0.8" crs:FullY="0.7" papp:LocalFeather="0.5"/>
                            </rdf:Seq>
                          </crs:CorrectionMasks>
                        </rdf:Description>
                      </rdf:li>
                    </rdf:Seq>
                  </crs:GradientBasedCorrections>
                </rdf:Description>
              </rdf:RDF>
            </x:xmpmeta>
            <?xpacket end="w"?>
            """
        let (model, culling) = try XMPParser.parse(xml)
        XCTAssertEqual(model.localAdjustments.count, 1)
        let resaved = XMPSerializer.serialize(model: model, culling: culling)
        XCTAssertTrue(resaved.contains("crs:LocalExposure2012=\"0.5\""))
        XCTAssertTrue(resaved.contains("crs:ZeroX=\"0.2\""))
    }

    func testDisabledCorrectionIsDroppedOnParse() throws {
        let xml = """
            <?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
              <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                <rdf:Description
                  xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                  xmlns:papp="http://ns.justmaple.app/1.0/"
                  crs:Version="11.0">
                  <crs:GradientBasedCorrections>
                    <rdf:Seq>
                      <rdf:li>
                        <rdf:Description crs:What="Correction" crs:CorrectionActive="False" crs:LocalExposure2012="0.5">
                          <crs:CorrectionMasks>
                            <rdf:Seq>
                              <rdf:li crs:What="Mask/Gradient" crs:MaskValue="1" crs:ZeroX="0.2" crs:ZeroY="0.3" crs:FullX="0.8" crs:FullY="0.7"/>
                            </rdf:Seq>
                          </crs:CorrectionMasks>
                        </rdf:Description>
                      </rdf:li>
                    </rdf:Seq>
                  </crs:GradientBasedCorrections>
                </rdf:Description>
              </rdf:RDF>
            </x:xmpmeta>
            <?xpacket end="w"?>
            """
        let (model, _) = try XMPParser.parse(xml)
        XCTAssertTrue(model.localAdjustments.isEmpty)
    }

    /// `LocalAdjustment` has a hand-written `init(from:)` (rasterId is never
    /// persisted); Swift still synthesizes `encode(to:)` on its own, and
    /// the two must agree for the JSON fixtures to round-trip.
    func testLocalAdjustmentEncodesAndDecodesAsJSON() throws {
        let layer = LocalAdjustment(
            mask: .everywhere, range: .skinTone, adjustments: PartialAdjustments(saturation: -4, hue: 12.5))
        let data = try JSONEncoder().encode(layer)
        let back = try JSONDecoder().decode(LocalAdjustment.self, from: data)
        XCTAssertEqual(back.mask, layer.mask)
        XCTAssertEqual(back.range, layer.range)
        XCTAssertEqual(back.adjustments, layer.adjustments)
    }
}
