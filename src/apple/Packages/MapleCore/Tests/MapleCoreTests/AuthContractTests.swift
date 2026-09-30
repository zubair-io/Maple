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
  func testNativeAuthResponseAcceptsEmailFreeAndLegacyAccounts() throws {
    for email in ["null", #""legacy@maple.test""#] {
      let data = Data(
        #"{"access_token":"access","refresh_token":"refresh","user":{"id":"member","email":\#(email),"role":"member","file_access":false}}"#
          .utf8)
      let response = try JSONDecoder().decode(AuthVerifyResponse.self, from: data)
      XCTAssertEqual(response.user.id, "member")
      XCTAssertEqual(response.user.email, email == "null" ? nil : "legacy@maple.test")
      XCTAssertFalse(response.user.hasFileAccess)
    }
  }
}
