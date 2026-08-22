import XCTest
import FileProvider
@testable import MapleCore

/// #2989: the OS's initial-page sentinels are the literal UTF-8 strings
/// "FPPageSortedByName"/"FPPageSortedByDate" — not opaque bytes — so a
/// decoder that only rejects empty/"0" pages forwards them to the server
/// as `next_cursor`, and every container enumeration dies with
/// `400 malformed cursor: FPPageSortedByName`. Tests construct the pages
/// from the framework constants so a future macOS rename fails loudly.
final class FileProviderPageCursorTests: XCTestCase {
    func testInitialPageSortedByNameDecodesToNoCursor() {
        let page = NSFileProviderPage(NSFileProviderPage.initialPageSortedByName as Data)
        XCTAssertNil(FileProviderPageCursor.decode(page))
    }

    func testInitialPageSortedByDateDecodesToNoCursor() {
        let page = NSFileProviderPage(NSFileProviderPage.initialPageSortedByDate as Data)
        XCTAssertNil(FileProviderPageCursor.decode(page))
    }

    func testEmptyAndZeroPagesDecodeToNoCursor() {
        XCTAssertNil(FileProviderPageCursor.decode(NSFileProviderPage(Data())))
        XCTAssertNil(FileProviderPageCursor.decode(NSFileProviderPage(Data("0".utf8))))
    }

    func testRealCursorRoundTrips() {
        let page = FileProviderPageCursor.encode("eyJvZmZzZXQiOjUwMH0")
        XCTAssertEqual(FileProviderPageCursor.decode(page), "eyJvZmZzZXQiOjUwMH0")
    }
}
