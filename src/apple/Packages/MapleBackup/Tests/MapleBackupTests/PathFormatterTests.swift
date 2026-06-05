import XCTest
@testable import MapleBackup

final class PathFormatterTests: XCTestCase {
    private func date(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    // Geo layout: USA → year/State/City/file; elsewhere → year/Country/City/file;
    // no location → year/MM/file (month kept as the grouping level).
    func testUSALocation() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: ["California", "San Francisco"],
                                     filename: "IMG_0420.HEIC"),
            "2024/California/San Francisco/IMG_0420.HEIC")
    }

    func testNonUSALocation() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: ["France", "Paris"],
                                     filename: "IMG_0420.HEIC"),
            "2024/France/Paris/IMG_0420.HEIC")
    }

    func testSingleSegment() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: ["Nevada"], filename: "IMG.heic"),
            "2024/Nevada/IMG.heic")
    }

    func testWithoutLocation() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: nil, filename: "IMG_0420.HEIC"),
            "2024/03/IMG_0420.HEIC")
    }

    func testEmptyListTreatedAsNoLocation() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: [], filename: "IMG.heic"),
            "2024/03/IMG.heic")
    }

    func testSegmentSlashEscaped() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: ["St. Tropez / Var", "Saint-Tropez"],
                                     filename: "IMG.heic"),
            "2024/St. Tropez _ Var/Saint-Tropez/IMG.heic")
    }

    func testDropsEmptyAndWhitespaceSegments() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: ["Japan", "   ", "Kyoto"],
                                     filename: "IMG.heic"),
            "2024/Japan/Kyoto/IMG.heic")
    }

    func testAllEmptySegmentsFallBack() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: ["", "  "], filename: "IMG.heic"),
            "2024/03/IMG.heic")
    }

    func testDotDotSegmentDropped() throws {
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: [".."], filename: "IMG.heic"),
            "2024/03/IMG.heic")
    }

    func testLeadingDotSegmentDropped() throws {
        // ".hidden" as a directory name would create a hidden folder — dropped.
        XCTAssertEqual(
            try PathFormatter.format(captureDate: date("2024-03-15T10:30:00Z"),
                                     location: [".hidden", "Paris"], filename: "IMG.heic"),
            "2024/Paris/IMG.heic")
    }

    func testFilenameWithSlashThrows() {
        XCTAssertThrowsError(try PathFormatter.format(
            captureDate: date("2024-03-15T10:30:00Z"),
            location: ["Japan", "Tokyo"],
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
