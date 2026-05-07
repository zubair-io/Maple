import XCTest
@testable import MapleCore

final class CloudAuthFlowTests: XCTestCase {
    /// AuthClient must conform to CloudAuthFlow so the view model can
    /// take it as a dependency. This test compiles iff the conformance
    /// exists; no behavior assertions yet.
    func test_AuthClient_conformsToCloudAuthFlow() {
        let url = URL(string: "https://example.test")!
        let client: any CloudAuthFlow = AuthClient(server: url)
        XCTAssertNotNil(client)
    }
}
