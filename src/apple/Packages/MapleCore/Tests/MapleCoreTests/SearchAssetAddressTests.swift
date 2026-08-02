// SearchAssetAddressTests.swift — SearchAsset decodes the unified address (#2518).

import XCTest
@testable import MapleCloudKit

final class SearchAssetAddressTests: XCTestCase {
    private func decode(_ json: String) throws -> SearchAsset {
        try JSONDecoder().decode(SearchAsset.self, from: Data(json.utf8))
    }

    func testDecodesAddressField() throws {
        let asset = try decode(#"""
        {"id":"fs:/srv/lib/2026/IMG_0042.dng","folder_id":"652f0000000000000000abcd",
         "abs_path":"/srv/lib/2026/IMG_0042.dng","address":"lib:2026/IMG_0042.dng",
         "filename":"IMG_0042.dng"}
        """#)
        XCTAssertEqual(asset.address, "lib:2026/IMG_0042.dng")
    }

    func testAddressAbsentDecodesNil() throws {
        // Backward compat: a server response predating unified addressing.
        let asset = try decode(#"""
        {"id":"fs:/x.dng","folder_id":"f","abs_path":"/x.dng","filename":"x.dng"}
        """#)
        XCTAssertNil(asset.address)
    }

    func testAddressNullDecodesNil() throws {
        let asset = try decode(#"""
        {"id":"fs:/x.dng","folder_id":"f","abs_path":"/x.dng","address":null,"filename":"x.dng"}
        """#)
        XCTAssertNil(asset.address)
    }
}
