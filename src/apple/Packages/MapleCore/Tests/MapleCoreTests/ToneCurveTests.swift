// ToneCurveTests.swift — the hand-written point-curve value type (#366).
//
// `ToneCurve` stores tuple points, so `Equatable` / `Hashable` / `Codable`
// are hand-rolled rather than synthesised — every one of them is exercised
// here, plus the invariant `AdjustmentModel` leans on: a default model
// carries four IDENTITY curves and therefore still equals `.default`.

import XCTest

@testable import MapleCore

final class ToneCurveTests: XCTestCase {

    // MARK: - Identity

    func testDefaultCurveIsIdentity() {
        XCTAssertTrue(ToneCurve().isIdentity)
        XCTAssertTrue(ToneCurve.identity.isIdentity)
        XCTAssertTrue(ToneCurve.identity.points.isEmpty)
    }

    func testCurveWithPointsIsNotIdentity() {
        XCTAssertFalse(ToneCurve(points: [(x: 0.5, y: 0.7)]).isIdentity)
    }

    func testDefaultModelCarriesIdentityCurves() {
        let m = AdjustmentModel.default
        XCTAssertTrue(m.toneCurveLuma.isIdentity)
        XCTAssertTrue(m.toneCurveRed.isIdentity)
        XCTAssertTrue(m.toneCurveGreen.isIdentity)
        XCTAssertTrue(m.toneCurveBlue.isIdentity)
    }

    // MARK: - Equatable / Hashable

    func testEqualityComparesPointsElementwise() {
        let a = ToneCurve(points: [(x: 0, y: 0), (x: 1, y: 1)])
        let b = ToneCurve(points: [(x: 0, y: 0), (x: 1, y: 1)])
        let c = ToneCurve(points: [(x: 0, y: 0), (x: 1, y: 0.9)])
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, c)
        XCTAssertNotEqual(a, ToneCurve(points: [(x: 0, y: 0)]))
    }

    func testHashMatchesEquality() {
        let a = ToneCurve(points: [(x: 0.25, y: 0.4)])
        let b = ToneCurve(points: [(x: 0.25, y: 0.4)])
        XCTAssertEqual(a.hashValue, b.hashValue)
        XCTAssertEqual(Set([a, b]).count, 1)
    }

    /// A curve makes `AdjustmentModel` differ from `.default` — the model's
    /// synthesised `Equatable` has to see through the hand-rolled one.
    func testModelEqualityTracksCurves() {
        var edited = AdjustmentModel.default
        edited.toneCurveLuma = ToneCurve(points: [(x: 0.5, y: 0.6)])
        XCTAssertNotEqual(edited, AdjustmentModel.default)
        XCTAssertTrue(edited.isVisuallyEditedBeyondWhiteBalance)
    }

    // MARK: - Codable

    func testCodableRoundTrip() throws {
        let original = ToneCurve(points: [(x: 0, y: 0), (x: 0.5, y: 0.62), (x: 1, y: 1)])
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ToneCurve.self, from: data)
        XCTAssertEqual(decoded, original)
    }

    func testPointsEncodeAsXYPairs() throws {
        let data = try JSONEncoder().encode(ToneCurve(points: [(x: 0.25, y: 0.5)]))
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let points = try XCTUnwrap(json["points"] as? [[Double]])
        XCTAssertEqual(points, [[0.25, 0.5]])
    }

    func testMissingPointsKeyDecodesAsIdentity() throws {
        let decoded = try JSONDecoder().decode(ToneCurve.self, from: Data("{}".utf8))
        XCTAssertTrue(decoded.isIdentity)
    }

    func testMalformedPairFailsToDecode() {
        let json = Data(#"{"points":[[0.25]]}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(ToneCurve.self, from: json))
    }

    func testModelCodableRoundTripPreservesCurves() throws {
        var model = AdjustmentModel.default
        model.toneCurveRed = ToneCurve(points: [(x: 0, y: 0.1), (x: 1, y: 0.9)])
        let data = try JSONEncoder().encode(model)
        let decoded = try JSONDecoder().decode(AdjustmentModel.self, from: data)
        XCTAssertEqual(decoded, model)
        XCTAssertEqual(decoded.toneCurveRed.points.count, 2)
        XCTAssertTrue(decoded.toneCurveBlue.isIdentity)
    }
}
