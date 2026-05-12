import XCTest
@testable import MapleBackup

final class PathFormatterTests: XCTestCase {
    private func date(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    func testWithLocation() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: "Tokyo", filename: "IMG_0420.HEIC"),
            "2024/Tokyo/03-15/IMG_0420.HEIC")
    }

    func testWithoutLocation() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: nil, filename: "IMG_0420.HEIC"),
            "2024/03/15/IMG_0420.HEIC")
    }

    func testLocationSlashEscaped() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: "St. Tropez / Var", filename: "IMG.heic"),
            "2024/St. Tropez _ Var/03-15/IMG.heic")
    }

    func testEmptyLocationTreatedAsNil() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: "", filename: "IMG.heic"),
            "2024/03/15/IMG.heic")
    }

    func testWhitespaceLocationTreatedAsNil() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: "   ", filename: "IMG.heic"),
            "2024/03/15/IMG.heic")
    }

    func testDotDotLocationTreatedAsNil() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: "..", filename: "IMG.heic"),
            "2024/03/15/IMG.heic")
    }

    func testLeadingDotLocationTreatedAsNil() throws {
        // ".hidden" as a directory name would create a hidden folder — fall back.
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: ".hidden", filename: "IMG.heic"),
            "2024/03/15/IMG.heic")
    }

    func testFilenameWithSlashThrows() {
        XCTAssertThrowsError(try PathFormatter.format(
            captureDate: date("2024-03-15T10:30:00Z"),
            location: "Tokyo",
            filename: "foo/bar.heic"))
    }

    func testFilenameWithDotDotThrows() {
        XCTAssertThrowsError(try PathFormatter.format(
            captureDate: date("2024-03-15T10:30:00Z"),
            location: nil,
            filename: "../etc/passwd"))
    }

    func testFilenameDotThrows() {
        XCTAssertThrowsError(try PathFormatter.format(
            captureDate: date("2024-03-15T10:30:00Z"),
            location: nil,
            filename: "."))
    }

    func testFilenameLeadingDotThrows() {
        XCTAssertThrowsError(try PathFormatter.format(
            captureDate: date("2024-03-15T10:30:00Z"),
            location: nil,
            filename: ".hidden"))
    }

    func testFilenameEmptyThrows() {
        XCTAssertThrowsError(try PathFormatter.format(
            captureDate: date("2024-03-15T10:30:00Z"),
            location: nil,
            filename: ""))
    }

    func testFilenameTooLongThrows() {
        XCTAssertThrowsError(try PathFormatter.format(
            captureDate: date("2024-03-15T10:30:00Z"),
            location: nil,
            filename: String(repeating: "a", count: 256)))
    }
}
