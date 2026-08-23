import XCTest
@testable import MapleUI

final class MuiStructuredDataMathTests: XCTestCase {
    func testJsonTextThenParseFieldsRoundTrips() {
        let fields = [
            MuiStructuredDataField(key: "camera", value: .string("Sony A7 IV")),
            MuiStructuredDataField(key: "iso", value: .number(400)),
            MuiStructuredDataField(key: "flagged", value: .bool(true)),
        ]
        let text = MuiStructuredDataMath.jsonText(from: fields)
        switch MuiStructuredDataMath.parseFields(from: text) {
        case .success(let parsed):
            XCTAssertEqual(parsed, fields)
        case .failure(let error):
            XCTFail("Expected a successful round trip, got \(error.message)")
        }
    }

    func testParseFieldsPreservesKeyOrder() {
        let text = "{\"b\": 1, \"a\": 2}"
        guard case .success(let fields) = MuiStructuredDataMath.parseFields(from: text) else {
            return XCTFail("Expected success")
        }
        XCTAssertEqual(fields.map(\.key), ["b", "a"])
    }

    func testParseFieldsRejectsMalformedJson() {
        guard case .failure = MuiStructuredDataMath.parseFields(from: "{not json") else {
            return XCTFail("Expected a failure")
        }
    }

    func testParseFieldsRejectsNestedObjects() {
        guard case .failure(let error) = MuiStructuredDataMath.parseFields(from: "{\"a\": {\"b\": 1}}") else {
            return XCTFail("Expected a failure")
        }
        XCTAssertEqual(error.message, MuiStructuredDataMath.flatObjectError)
    }

    func testCoerceLikePreservesOriginalType() {
        XCTAssertEqual(MuiStructuredDataMath.coerceLike(.number(1), raw: "42"), .number(42))
        XCTAssertEqual(MuiStructuredDataMath.coerceLike(.bool(false), raw: "true"), .bool(true))
        XCTAssertEqual(MuiStructuredDataMath.coerceLike(.string("x"), raw: "y"), .string("y"))
    }

    func testCoerceLikeNumberFallsBackToZeroOnUnparsable() {
        XCTAssertEqual(MuiStructuredDataMath.coerceLike(.number(1), raw: "not-a-number"), .number(0))
    }
}
