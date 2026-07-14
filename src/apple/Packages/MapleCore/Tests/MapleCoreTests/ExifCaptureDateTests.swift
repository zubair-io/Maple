// ExifCaptureDateTests.swift — golden-vector parity for ExifCaptureDate
// (#1995).
//
// The expected outputs below were NOT hand-computed from reading the
// algorithm — they were captured by actually running the real TypeScript
// `normalizeExif` (`src/api/src/indexer/exif.ts`) under `bun run` against
// each case's raw EXIF string, with `TZ=UTC` forced on the process:
//
//   TZ=UTC bun run <script calling normalizeExif({ DateTimeOriginal: <case> })>
//
// `TZ=UTC` matters: EXIF `DateTimeOriginal` has no timezone designator, and
// both the server's `asIsoDate` string-fallback path AND exifr's own
// `reviveDate` (the path most real photos take) interpret those wall-clock
// components as LOCAL time of whatever process parses them — confirmed
// empirically during #1995 by running the same script under
// `TZ=America/New_York`, which shifted every `captured_at` by exactly the
// zone's UTC offset (e.g. "2024:06:01 12:34:56" -> "...T16:34:56.000Z"
// instead of "...T12:34:56.000Z"). `ExifCaptureDate` assumes the server
// process runs in UTC — see its doc comment for the evidence and the
// explicit caveat that this is an assumption, not a proven fact about the
// deployed host. These golden vectors encode THAT assumption; if the
// assumption is ever wrong, the fix is in `ExifCaptureDate`'s timezone
// handling, and these vectors should be regenerated the same way (real
// `bun run` against the real TS, not by hand).

import XCTest
@testable import MapleCore

final class ExifCaptureDateTests: XCTestCase {

    // MARK: - Golden vectors (TZ=UTC, verified against real src/api/src/indexer/exif.ts)

    func testBasicSpaceSeparated() {
        XCTAssertEqual(
            ExifCaptureDate.iso8601UTC(fromExifString: "2024:06:01 12:34:56"),
            "2024-06-01T12:34:56.000Z")
    }

    func testTSeparatedVariant() {
        // ImageIO never emits a "T"-separated DateTimeOriginal in practice
        // (the EXIF spec mandates a space), but the server's regex accepts
        // either — matching it exactly means this port must too.
        XCTAssertEqual(
            ExifCaptureDate.iso8601UTC(fromExifString: "2024:06:01T12:34:56"),
            "2024-06-01T12:34:56.000Z")
    }

    func testMidnight() {
        XCTAssertEqual(
            ExifCaptureDate.iso8601UTC(fromExifString: "2000:01:01 00:00:00"),
            "2000-01-01T00:00:00.000Z")
    }

    func testYearBoundary() {
        XCTAssertEqual(
            ExifCaptureDate.iso8601UTC(fromExifString: "2023:12:31 23:59:59"),
            "2023-12-31T23:59:59.000Z")
    }

    func testLeapDay() {
        XCTAssertEqual(
            ExifCaptureDate.iso8601UTC(fromExifString: "2024:02:29 08:15:30"),
            "2024-02-29T08:15:30.000Z")
    }

    func testTrailingFractionalSecondsIgnored() {
        // The server's regex is a PREFIX match (no `$` anchor) — trailing
        // content past the 6 captured groups is ignored by `RegExp.exec`.
        // Real EXIF DateTimeOriginal never carries a fractional suffix (that's
        // a separate tag, SubsecTimeOriginal), but the port must match the
        // server's actual regex semantics, not just the common case.
        XCTAssertEqual(
            ExifCaptureDate.iso8601UTC(fromExifString: "2024:06:01 12:34:56.789"),
            "2024-06-01T12:34:56.000Z")
    }

    func testUSDaylightSavingSpringForwardDateIsNotSpecialCased() {
        // Under TZ=UTC there is no DST transition to special-case — this
        // just confirms the port doesn't accidentally introduce one.
        XCTAssertEqual(
            ExifCaptureDate.iso8601UTC(fromExifString: "2024:03:10 02:30:00"),
            "2024-03-10T02:30:00.000Z")
    }

    func testUSDaylightSavingFallBackDateIsNotSpecialCased() {
        XCTAssertEqual(
            ExifCaptureDate.iso8601UTC(fromExifString: "2024:11:03 01:30:00"),
            "2024-11-03T01:30:00.000Z")
    }

    // MARK: - Malformed / absent input

    func testEmptyStringReturnsNil() {
        XCTAssertNil(ExifCaptureDate.iso8601UTC(fromExifString: ""))
    }

    func testGarbageStringReturnsNil() {
        XCTAssertNil(ExifCaptureDate.iso8601UTC(fromExifString: "not a date"))
    }

    func testOutOfRangeMonthReturnsNil() {
        XCTAssertNil(ExifCaptureDate.iso8601UTC(fromExifString: "2024:13:01 12:00:00"))
    }

    func testOutOfRangeHourReturnsNil() {
        XCTAssertNil(ExifCaptureDate.iso8601UTC(fromExifString: "2024:06:01 25:00:00"))
    }

    func testInvalidDayForMonthReturnsNil() {
        // February never has a 30th, leap year or not.
        XCTAssertNil(ExifCaptureDate.iso8601UTC(fromExifString: "2024:02:30 12:00:00"))
    }

    func testZeroMonthReturnsNil() {
        XCTAssertNil(ExifCaptureDate.iso8601UTC(fromExifString: "2024:00:01 12:00:00"))
    }

    func testZeroDayReturnsNil() {
        XCTAssertNil(ExifCaptureDate.iso8601UTC(fromExifString: "2024:06:00 12:00:00"))
    }

    // MARK: - Determinism

    func testDeterministic() {
        let a = ExifCaptureDate.iso8601UTC(fromExifString: "2024:06:01 12:34:56")
        let b = ExifCaptureDate.iso8601UTC(fromExifString: "2024:06:01 12:34:56")
        XCTAssertEqual(a, b)
    }
}
