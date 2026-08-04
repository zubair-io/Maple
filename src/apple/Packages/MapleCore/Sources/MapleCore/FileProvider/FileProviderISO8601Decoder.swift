// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderISO8601Decoder.swift
//
// Shared date-decoding strategy for every JSON response the File Provider
// layer decodes from the API. Extracted from RemoteCatalog (#2534) so
// RemoteCatalog and ChangeFeedClient can't silently diverge on how they
// parse the server's timestamps — they previously used two independent
// implementations, and ChangeFeedClient's (plain `.iso8601`) never got the
// fractional-seconds fix RemoteCatalog needed.

import Foundation

extension JSONDecoder {
    /// Decodes the server's ISO-8601 timestamps.
    ///
    /// `Date.toISOString()` (the server's emitter, e.g.
    /// `src/api/src/routes/changes.ts`) always includes fractional seconds
    /// (`"2026-05-15T10:00:00.123Z"`). `JSONDecoder`'s built-in `.iso8601`
    /// convenience strategy is a black box whose fractional-seconds
    /// handling isn't guaranteed across Foundation versions — this uses
    /// two explicit `ISO8601DateFormatter`s instead (fractional first,
    /// then plain), matching exactly what each one does and does not
    /// accept, so the behavior doesn't depend on undocumented leniency in
    /// a system convenience API.
    static func mapleFileProviderDecoder() -> JSONDecoder {
        let d = JSONDecoder()
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = withFractional.date(from: raw) { return date }
            if let date = plain.date(from: raw) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(raw)",
            )
        }
        return d
    }
}
