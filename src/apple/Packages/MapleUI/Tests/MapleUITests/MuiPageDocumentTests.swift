import XCTest
@testable import MapleUI

final class MuiPageDocumentTests: XCTestCase {
    private let docs: [MuiPageDocumentEntry] = [
        MuiPageDocumentEntry(id: "iceland", title: "Iceland", body: "…", backlinks: [], versions: []),
        MuiPageDocumentEntry(id: "faroe", title: "Faroe", body: "…", backlinks: [], versions: []),
    ]

    func testDocumentReturnsTheMatchingEntry() {
        XCTAssertEqual(MuiPageDocument.document(for: "faroe", in: docs)?.title, "Faroe")
    }

    func testDocumentReturnsNilForANilId() {
        XCTAssertNil(MuiPageDocument.document(for: nil, in: docs))
    }

    func testDocumentReturnsNilForAnIdThatDoesNotExist() {
        XCTAssertNil(MuiPageDocument.document(for: "missing", in: docs))
    }
}
