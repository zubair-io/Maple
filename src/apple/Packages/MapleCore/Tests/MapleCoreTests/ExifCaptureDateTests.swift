// ExifCaptureDateTests.swift — golden-vector parity for ExifCaptureDate
// (#1995, #5082).
//
// Every `iso8601UTC` expectation and every dated `capturedAt` expectation was
// captured by running the real `normalizeExif` (`src/api/src/indexer/exif.ts`)
// on the same raw EXIF string; its `Date.UTC` reading does not depend on the
// process timezone. The exception is
// `testAnOriginalDateOnlyJavaScriptReadsAlsoFallsThrough`, a known mismatch:
// the server dates those strings with `new Date(...)`, which the device cannot
// reproduce, so it falls through to CreateDate.

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

    // MARK: - JavaScript `Date.UTC` semantics (#5082)
    //
    // The server's `asIsoDate` feeds each matched field to `Date.UTC`, which
    // rolls out-of-range values forward, maps years 0–99 to 1900–1999 and uses
    // the proleptic Gregorian calendar. Rejecting these on the device (the
    // pre-#5082 behaviour) derived a fallback id where the server stamps a
    // primary one.

    func testOutOfRangeValuesRollForwardLikeTheServer() {
        let expected = [
            "2024:13:01 12:00:00": "2025-01-01T12:00:00.000Z",
            "2024:06:01 24:00:00": "2024-06-02T00:00:00.000Z",
            "2024:06:01 25:00:00": "2024-06-02T01:00:00.000Z",
            "2023:02:30 12:00:00": "2023-03-02T12:00:00.000Z",
            "2024:02:30 12:00:00": "2024-03-01T12:00:00.000Z",
            "2024:00:10 12:00:00": "2023-12-10T12:00:00.000Z",
            "2024:00:01 12:00:00": "2023-12-01T12:00:00.000Z",
            "2024:06:00 12:00:00": "2024-05-31T12:00:00.000Z",
            "2024:06:01 12:60:00": "2024-06-01T13:00:00.000Z",
            "2024:06:01 12:00:61": "2024-06-01T12:01:01.000Z",
        ]
        for (exif, iso) in expected {
            XCTAssertEqual(ExifCaptureDate.iso8601UTC(fromExifString: exif), iso, exif)
        }
    }

    func testTwoDigitYearsAndTheZeroPlaceholderMatchTheServer() {
        let expected = [
            "0000:00:00 00:00:00": "1899-11-30T00:00:00.000Z",
            "0024:06:01 12:34:56": "1924-06-01T12:34:56.000Z",
            "0099:12:31 23:59:59": "1999-12-31T23:59:59.000Z",
            "0100:01:01 00:00:00": "0100-01-01T00:00:00.000Z",
            "9999:99:99 99:99:99": "+010007-06-11T04:40:39.000Z",
        ]
        for (exif, iso) in expected {
            XCTAssertEqual(ExifCaptureDate.iso8601UTC(fromExifString: exif), iso, exif)
        }
    }

    // MARK: - Field order (#5082)

    func testOriginalDateWinsOverDigitized() {
        XCTAssertEqual(
            ExifCaptureDate.capturedAt(
                dateTimeOriginal: "2024:06:01 12:34:56", createDate: "2020:01:01 00:00:00"),
            "2024-06-01T12:34:56.000Z")
    }

    func testAnOriginalDateWithoutDigitsFallsBackToDigitizedLikeTheServer() {
        for original in [nil, "", "    :  :     :  :  ", "unknown"] as [String?] {
            XCTAssertEqual(
                ExifCaptureDate.capturedAt(
                    dateTimeOriginal: original, createDate: "2024:06:01 12:34:56"),
                "2024-06-01T12:34:56.000Z", String(describing: original))
        }
    }

    /// The server's `new Date(...)` fallback rejects these, so it moves on to
    /// CreateDate; the device must too (#5092 review).
    func testAnOriginalDateJavaScriptRejectsFallsThroughToDigitized() {
        for original in ["2024:xx:xx", "2024:13:xx 12:00:00", "24:06:01 12:34:56"] {
            XCTAssertEqual(
                ExifCaptureDate.capturedAt(
                    dateTimeOriginal: original, createDate: "2020:01:01 00:00:00"),
                "2020-01-01T00:00:00.000Z", original)
        }
    }

    /// JavaScript does read these, which the device cannot reproduce, so it
    /// falls through as well — a known mismatch either way; a wrong date can
    /// only collide with a file sharing its first 64 KB.
    func testAnOriginalDateOnlyJavaScriptReadsAlsoFallsThrough() {
        for original in ["2024-06-01T12:34:56", "2024:06:01", "06/01/2024 12:34"] {
            XCTAssertEqual(
                ExifCaptureDate.capturedAt(
                    dateTimeOriginal: original, createDate: "2020:01:01 00:00:00"),
                "2020-01-01T00:00:00.000Z", original)
        }
    }

    /// exifr strips NUL termination and surrounding spaces before the server's
    /// `asIsoDate` sees the string.
    func testSurroundingSpacesAndNulsAreTrimmedLikeExifr() {
        let padded = [
            " 2024:06:01 12:34:56", "2024:06:01 12:34:56 ", "2024:06:01 12:34:56\u{0}\u{0}",
        ]
        for original in padded {
            XCTAssertEqual(
                ExifCaptureDate.capturedAt(
                    dateTimeOriginal: original, createDate: "2020:01:01 00:00:00"),
                "2024-06-01T12:34:56.000Z", original.debugDescription)
        }
    }

    /// `trim()` strips exactly ECMAScript's whitespace and line terminators:
    /// U+FEFF and U+3000 go, U+0085 stays and makes `asIsoDate` reject the
    /// field, so the server falls through to CreateDate (#5092 review).
    func testOnlyJavaScriptWhitespaceIsTrimmed() {
        for pad in ["\u{A0}", "\u{3000}", "\u{2028}", "\u{FEFF}", "\u{B}", "\u{C}"] {
            XCTAssertEqual(
                ExifCaptureDate.capturedAt(
                    dateTimeOriginal: pad + "2024:06:01 12:34:56" + pad,
                    createDate: "2020:01:01 00:00:00"),
                "2024-06-01T12:34:56.000Z", pad.debugDescription)
        }
        XCTAssertEqual(
            ExifCaptureDate.capturedAt(
                dateTimeOriginal: "\u{85}2024:06:01 12:34:56\u{85}",
                createDate: "2020:01:01 00:00:00"),
            "2020-01-01T00:00:00.000Z")
    }

    /// The 25 BMP code points for which Bun's `String.fromCodePoint(c).trim()`
    /// is empty; no supplementary code point is ECMAScript whitespace.
    func testTheTrimSetIsExactlyJavaScriptsWhitespace() {
        let javaScript: Set<UInt32> = Set(
            [0x9, 0xA, 0xB, 0xC, 0xD, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F]
                + [0x3000, 0xFEFF] + Array(0x2000...0x200A))
        let swift = Set(
            (0...0xFFFF).compactMap(Unicode.Scalar.init)
                .filter(CharacterSet.ecmaScriptWhitespace.contains).map(\.value))
        XCTAssertEqual(swift, javaScript)
    }

    func testNoUsableFieldYieldsNoDate() {
        XCTAssertNil(ExifCaptureDate.capturedAt(dateTimeOriginal: nil, createDate: nil))
        XCTAssertNil(ExifCaptureDate.capturedAt(dateTimeOriginal: "", createDate: "unknown"))
    }

    // MARK: - Shared goldens (also pinned by tests/maple-id-contract.test.ts and raw-core)

    private func deviceId(_ name: String) throws -> String? {
        let url = try WorkflowFixture.root().appendingPathComponent("ids/\(name)")
        let dates = ImageMetadataReader.readRawCaptureDateStrings(from: url)
        let captured = ExifCaptureDate.capturedAt(
            dateTimeOriginal: dates.dateTimeOriginal, createDate: dates.createDate)
        let head = try Data(contentsOf: url).prefix(64 * 1024)
        return captured.flatMap { MapleId.primary(headBytes: Data(head), capturedAtISO8601: $0) }
    }

    func testABlankOriginalDateDerivesTheServersDigitizedDatedId() throws {
        XCTAssertEqual(
            try deviceId("still-blank-original-date.jpg"), "01b070aac318b20a45cf629b2d2f1709")
    }

    func testTheZeroOriginalDatePlaceholderDerivesTheServersId() throws {
        XCTAssertEqual(
            try deviceId("still-zero-original-date.jpg"), "012f4ad811f9fb08900967db02879d0d")
    }

    // MARK: - Determinism

    func testDeterministic() {
        let a = ExifCaptureDate.iso8601UTC(fromExifString: "2024:06:01 12:34:56")
        let b = ExifCaptureDate.iso8601UTC(fromExifString: "2024:06:01 12:34:56")
        XCTAssertEqual(a, b)
    }
}
