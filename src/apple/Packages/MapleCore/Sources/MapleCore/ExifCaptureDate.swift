// src/apple/Packages/MapleCore/Sources/MapleCore/ExifCaptureDate.swift
//
// EXIF DateTimeOriginal/CreateDate -> ISO 8601 UTC, byte-for-byte matching
// the server indexer's `asIsoDate` (#1995, #5082).
//
// The server reads the RAW EXIF strings (`withRawCaptureDates` re-parses the
// two date tags with exifr's revival off) and hands each to `asIsoDate`,
// whose string branch feeds a "YYYY:MM:DD HH:MM:SS" prefix match to
// `Date.UTC(...)`. That reads the wall-clock fields as UTC whatever the
// indexer host's timezone, so the device needs no timezone assumption.
// Apple reads the same raw strings through ImageIO (`ImageMetadataReader
// .readRawCaptureDateStrings`). The output must be byte-identical to the
// server's for the same string: maple_id's primary form hashes it verbatim
// (`raw_core::MapleId::primary`), so any divergence gives the same photo two
// ids.
import Foundation

public enum ExifCaptureDate {

    /// Prefix-match pattern for the EXIF wall-clock date-time, mirroring the
    /// server's `/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/`
    /// exactly (using `[0-9]` rather than `\d` — ICU regex's `\d` matches
    /// any Unicode decimal digit by default, wider than JavaScript's
    /// ASCII-only `\d`; EXIF ASCII tag content is always plain ASCII
    /// digits, but `[0-9]` removes the discrepancy rather than relying on
    /// that always being true). No `$` anchor — this is a PREFIX match, so
    /// trailing content (a fractional-seconds suffix some non-conformant
    /// writer might emit, or outright garbage) is ignored, exactly matching
    /// `RegExp.exec`'s semantics on an unanchored pattern.
    private static let pattern: NSRegularExpression = {
        do {
            return try NSRegularExpression(
                pattern: "^([0-9]{4}):([0-9]{2}):([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})")
        } catch {
            // The pattern is a compile-time constant; a failure here means a
            // typo in the literal above, not a runtime condition any caller
            // could recover from — matches this file's other "can't happen"
            // invariants rather than threading an Optional through every
            // call site for an error class that can only occur from source
            // corruption.
            preconditionFailure("ExifCaptureDate: invalid built-in regex pattern: \(error)")
        }
    }()

    /// Parse an EXIF-format capture-date string ("YYYY:MM:DD HH:MM:SS",
    /// optionally "T"-separated, any trailing content ignored) as **UTC**
    /// wall-clock time and format it as an ISO 8601 string with millisecond
    /// precision — `YYYY-MM-DDTHH:mm:ss.000Z` — matching the server
    /// indexer's `asIsoDate` output.
    ///
    /// Returns `nil` only when `s` doesn't match the prefix. A match is read
    /// exactly as the server's `Date.UTC` reads it (#5082): out-of-range
    /// fields roll forward (month 13 → January of the next year, day 0 → the
    /// previous month's last day), years 0–99 mean 1900–1999, the calendar is
    /// proleptic Gregorian, and years past 9999 use `toISOString`'s
    /// `+YYYYYY` form. Camera placeholders such as `0000:00:00 00:00:00`
    /// therefore date a photo (1899-11-30) on the device exactly as they do on
    /// the server.
    public static func iso8601UTC(fromExifString s: String) -> String? {
        let ns = s as NSString
        guard
            let match = pattern.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)),
            match.numberOfRanges == 7
        else { return nil }
        let fields = (1...6).compactMap { Int(ns.substring(with: match.range(at: $0))) }
        guard fields.count == 6 else { return nil }
        let year = (0...99).contains(fields[0]) ? 1900 + fields[0] : fields[0]
        let monthIndex = fields[1] - 1
        let days =
            daysFromCivil(
                year: year + floorDiv(monthIndex, 12), month: floorMod(monthIndex, 12) + 1, day: 1)
            + fields[2] - 1
        let seconds = days * 86_400 + fields[3] * 3_600 + fields[4] * 60 + fields[5]
        return toISOString(secondsSinceEpoch: seconds)
    }

    /// The server's `asIsoDate(DateTimeOriginal) ?? asIsoDate(CreateDate)`,
    /// for the raw EXIF strings ImageIO reports (`CreateDate` is EXIF
    /// DateTimeDigitized).
    ///
    /// A field that is absent or doesn't match the EXIF prefix (including a
    /// blank `    :  :     :  :  ` placeholder) falls through to the next.
    /// For a non-prefix field with digits the server tries `new Date(...)`,
    /// which the device cannot reproduce: when JavaScript rejects it the
    /// server falls through too and the ids match; when JavaScript reads it
    /// they differ whatever the device does, and a wrong date can only
    /// collide with a file sharing its first 64 KB, which the primary form
    /// also hashes.
    ///
    /// Each field is first trimmed the way exifr's `normalizeString` hands it
    /// to the server: trailing NULs dropped, then surrounding whitespace.
    public static func capturedAt(dateTimeOriginal: String?, createDate: String?) -> String? {
        [dateTimeOriginal, createDate].lazy
            .compactMap { $0.map(exifrNormalized) }
            .compactMap(iso8601UTC(fromExifString:))
            .first
    }

    private static func exifrNormalized(_ raw: String) -> String {
        String(raw.reversed().drop { $0 == "\u{0}" }.reversed())
            .trimmingCharacters(in: .ecmaScriptWhitespace)
    }

    private static func floorDiv(_ a: Int, _ b: Int) -> Int {
        (a - floorMod(a, b)) / b
    }

    private static func floorMod(_ a: Int, _ b: Int) -> Int {
        ((a % b) + b) % b
    }

    /// Days from 1970-01-01 to `year-month-day` in the proleptic Gregorian
    /// calendar (Hinnant's `days_from_civil`), as ECMA-262's `MakeDay` counts.
    private static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = floorDiv(y, 400)
        let yearOfEra = y - era * 400
        let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    /// `Date.prototype.toISOString` for a whole-second UTC instant.
    private static func toISOString(secondsSinceEpoch: Int) -> String {
        let days = floorDiv(secondsSinceEpoch, 86_400)
        let secondOfDay = floorMod(secondsSinceEpoch, 86_400)
        let z = days + 719_468
        let era = floorDiv(z, 146_097)
        let dayOfEra = z - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let mp = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
        let yearText =
            (0...9999).contains(year)
            ? String(format: "%04d", year) : "+" + String(format: "%06d", year)
        return yearText
            + String(
                format: "-%02d-%02dT%02d:%02d:%02d.000Z", month, day, secondOfDay / 3_600,
                secondOfDay / 60 % 60, secondOfDay % 60)
    }
}
