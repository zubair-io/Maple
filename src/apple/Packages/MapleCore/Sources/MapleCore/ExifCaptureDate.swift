// src/apple/Packages/MapleCore/Sources/MapleCore/ExifCaptureDate.swift
//
// EXIF DateTimeOriginal/CreateDate -> ISO 8601 UTC, byte-for-byte matching
// the server indexer's `asIsoDate` (#1995).
//
// Ports the string branch of `src/api/src/indexer/exif.ts`'s `asIsoDate` —
// Apple reads EXIF via ImageIO, which surfaces the raw
// "YYYY:MM:DD HH:MM:SS" tag string (see `ImageMetadataReader
// .readRawCaptureDateStrings`), not a pre-parsed `Date` the way exifr's
// `reviveDate` hands the server's `normalizeExif` for most real photos. The
// output of this function must be byte-identical to what the server would
// compute for the same EXIF string, because maple_id's primary form hashes
// this string verbatim (`raw_core::MapleId::primary` / `maple_id_primary`)
// — any divergence here silently breaks cross-platform id parity (the same
// photo hashes to two different ids depending on which side computed it).
//
// ## The timezone assumption — READ THIS BEFORE CHANGING ANYTHING BELOW
//
// EXIF `DateTimeOriginal` carries no timezone designator: "2024:06:01
// 12:34:56" doesn't say whether that's UTC, PST, or anything else. The
// server's `asIsoDate` (src/api/src/indexer/exif.ts) handles the ambiguity
// by feeding the string (reformatted with a "T" separator, still with no
// timezone suffix) to JavaScript's `new Date(...)` constructor. Per
// ECMA-262, `Date.parse` of a date-time string that omits a timezone offset
// is interpreted as **local time of the process that calls it** — i.e. the
// answer depends on whatever timezone the Bun/Node indexer process happens
// to be running in. This is not unique to the string-fallback branch:
// exifr's own `reviveDate` (node_modules/exifr/src/dicts/tiff-revivers.mjs,
// the path most real photos actually take, since exifr pre-parses
// DateTimeOriginal into a `Date` before `asIsoDate` ever sees it) builds via
// `new Date(year, month - 1, day)` + `.setHours/.setMinutes/.setSeconds` —
// the multi-argument `Date` constructor, which is ALSO always local-time
// interpretation. So the ambiguity is baked into every path the server can
// take, not a quirk of one branch.
//
// This port assumes the indexer process's system timezone is **UTC**.
// Evidence for that assumption, gathered from this repo — NOT proof of it:
//   - `src/api/Dockerfile`'s runtime stage (`oven/bun:1.3-slim`, a Debian
//     base) sets no `TZ` and installs no tzdata override; Debian slim images
//     default to UTC absent explicit configuration.
//   - `src/api/docker-compose.yml` (the `maple` service) and
//     `src/api/maple.service` (the alternate bare-metal/systemd deploy path)
//     likewise set no `TZ`.
//   - This codebase's other UTC-bucketing conventions (see
//     `docs/plans/2026-05-31-imports-feature.md`: "Bucketing timezone: UTC
//     (matches formatBackupPath)") suggest UTC is the house default whenever
//     a timezone choice has to be made without better information.
//   - `PhotoKitAssetReader.readExifCaptureDateISO8601UTC`
//     (`src/apple/Maple/Backup/PhotoKitAssetReader.swift`, the existing
//     device-side PhotoKit backup path) already independently made the same
//     UTC assumption for the identical reason, and its own doc comment
//     flags the identical caveat. That is corroborating precedent, not
//     independent proof.
//
// It is explicitly NOT proof: the bare-metal systemd deploy path
// (`maple.service`) inherits whatever `/etc/localtime` the HOST machine has
// configured, which nothing in this repo can see. This was verified
// empirically during #1995 by running the real
// `src/api/src/indexer/exif.ts` (`normalizeExif`) under `bun run` with
// different `TZ` values — the SAME EXIF string produced `captured_at`
// values that differed by exactly the process's UTC offset:
//
//     TZ=UTC:               "2024:06:01 12:34:56" -> "2024-06-01T12:34:56.000Z"
//     TZ=America/New_York:  "2024:06:01 12:34:56" -> "2024-06-01T16:34:56.000Z"
//
// If the indexer's actual deployed host is not UTC, primary-form ids
// computed by this function will NOT match the ids the server computes for
// the same file, and Apple/server dedup will silently miss for every asset
// with a capture timestamp. This is flagged as an open question for #1995 —
// deliberately NOT silently resolved by guessing.

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
    /// indexer's `asIsoDate` output when the indexer process runs with UTC
    /// as its system timezone (see the type's doc comment above for the
    /// caveat on that assumption).
    ///
    /// Returns `nil` when `s` doesn't match the expected prefix, or when the
    /// numeric components don't form a valid calendar date/time (month
    /// outside 1–12, hour outside 0–23, minute/second outside 0–59, or a day
    /// that doesn't exist in the given month/year — e.g. day 30 in
    /// February). Real camera EXIF never emits out-of-range values here;
    /// this port does not attempt to replicate JavaScript `Date` engines'
    /// specific overflow/rejection quirks for malformed input (e.g. V8
    /// silently rolls a day-of-month overflow into the next month while
    /// rejecting an out-of-range month outright — an inconsistency not worth
    /// reproducing for input that never occurs in practice). Callers should
    /// treat `nil` as "no usable capture timestamp" and fall back to
    /// fallback-form id derivation, exactly as the server does when
    /// `asIsoDate` returns `null`.
    public static func iso8601UTC(fromExifString s: String) -> String? {
        let ns = s as NSString
        guard
            let match = pattern.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)),
            match.numberOfRanges == 7
        else { return nil }

        func component(_ group: Int) -> Int? {
            let r = match.range(at: group)
            guard r.location != NSNotFound else { return nil }
            return Int(ns.substring(with: r))
        }

        guard
            let year = component(1), let month = component(2), let day = component(3),
            let hour = component(4), let minute = component(5), let second = component(6)
        else { return nil }

        guard (1...12).contains(month), (0...23).contains(hour),
              (0...59).contains(minute), (0...59).contains(second)
        else { return nil }

        var utcCalendar = Calendar(identifier: .gregorian)
        // Force-unwrap is safe: "UTC" is always a valid TimeZone identifier
        // on every platform Foundation ships on.
        utcCalendar.timeZone = TimeZone(identifier: "UTC")!

        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        components.second = second

        guard let date = utcCalendar.date(from: components),
              // Defends against `Calendar.date(from:)` normalizing an
              // out-of-range day (e.g. Feb 30) into the following month
              // instead of failing outright — Foundation's leniency here is
              // implementation-defined and not something this port should
              // depend on either way. Requiring the round-tripped day to
              // match what was requested makes this function reject
              // invalid calendar dates regardless of which behavior the
              // underlying Calendar implementation chooses.
              utcCalendar.component(.day, from: date) == day
        else { return nil }

        return isoFormatter.string(from: date)
    }

    /// ISO 8601 UTC formatter with millisecond precision —
    /// `YYYY-MM-DDTHH:mm:ss.sssZ`, matching JavaScript's
    /// `Date.prototype.toISOString()`, the exact wire format the server's
    /// `asIsoDate` emits and `maple_id`'s primary form hashes.
    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")!
        return f
    }()
}
