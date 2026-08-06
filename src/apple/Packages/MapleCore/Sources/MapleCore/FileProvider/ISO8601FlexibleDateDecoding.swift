// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/ISO8601FlexibleDateDecoding.swift
//
// Shared date-decoding strategy for every FileProvider JSON payload that
// carries a server-emitted timestamp.
//
// `Date.toISOString()` (the server's emitter — see e.g.
// `src/api/src/routes/changes.ts`) always includes fractional seconds
// (`2026-05-15T10:00:00.123Z`), but Foundation's `.iso8601` JSONDecoder
// strategy does NOT parse them — every decode of a server timestamp would
// fail. Try fractional first, then plain, so both shapes round-trip.
//
// Originally hand-rolled inside `RemoteCatalog`'s private `decoder`;
// factored out here so `ChangeFeedClient` (and any future FileProvider
// JSON consumer) shares the exact same fix instead of re-deriving it —
// see #2534.

import Foundation

enum ISO8601FlexibleDateDecoding {
    private static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Parses `raw` as ISO-8601, tolerating both the fractional-second
    /// form the server emits and the plain whole-second form. Returns
    /// nil if neither formatter can parse it.
    static func date(from raw: String) -> Date? {
        withFractional.date(from: raw) ?? plain.date(from: raw)
    }

    /// `JSONDecoder.dateDecodingStrategy` built on `date(from:)` above.
    /// Assign directly to a decoder's `dateDecodingStrategy`, or use the
    /// `decoder` convenience below for the common case of a decoder that
    /// needs no other configuration.
    static var strategy: JSONDecoder.DateDecodingStrategy {
        .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = date(from: raw) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(raw)",
            )
        }
    }

    /// A fresh `JSONDecoder` pre-configured with `strategy`.
    static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = strategy
        return d
    }
}
