import XCTest
@testable import MapleCore

final class MaskCoordinatePrecisionTests: XCTestCase {
    func testFineCoordinatesSurviveRepeatedRoundTrips() throws {
        var model = AdjustmentModel()
        model.localAdjustments = [
            LocalAdjustment(
                mask: .linear(start: MaskPoint(x: 0.300698, y: 0.500123),
                              end: MaskPoint(x: 0.700321, y: 0.499876), feather: 0.5),
                adjustments: PartialAdjustments()),
            LocalAdjustment(
                mask: .radial(center: MaskPoint(x: 0.500698, y: 0.499876),
                              radii: MaskPoint(x: 0.001234, y: 0.002345),
                              angle: 0, feather: 0.5, invert: false),
                adjustments: PartialAdjustments()),
        ]
        let xml = XMPSerializer.serialize(model: model, culling: CullingState())
        XCTAssertTrue(xml.contains("crs:ZeroX=\"0.300698\" crs:ZeroY=\"0.500123\""))
        XCTAssertTrue(xml.contains("crs:Top=\"0.497531\" crs:Left=\"0.499464\" crs:Bottom=\"0.502221\" crs:Right=\"0.501932\""))
        var current = xml
        for _ in 0..<5 {
            let (parsed, culling) = try XMPParser.parse(current)
            XCTAssertEqual(parsed.localAdjustments.count, 2)
            current = XMPSerializer.serialize(model: parsed, culling: culling)
            XCTAssertEqual(current, xml)
        }
    }
}
