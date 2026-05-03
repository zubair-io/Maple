import XCTest
@testable import MapleCore

final class AuthContractTests: XCTestCase {
  func testContractFixtureLoads() throws {
    let url = Bundle.module.url(forResource: "auth-contract", withExtension: "json")
    let data = try Data(contentsOf: XCTUnwrap(url))
    let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let eps = (json?["endpoints"] as? [[String: Any]]) ?? []
    XCTAssertEqual(eps.count, 14)
  }
}
