/**
 RemoteCatalog + change feed accessors (Phase 5b).

 Splits the change-feed reads out of the base RemoteCatalog so Phase 5c
 can extend `getThumb` independently. Relies on `server` and `check2xx`
 being `internal` (bumped from `private` by this phase).
 */

import Foundation

/// Thrown by `listChanges` when the server returns HTTP 409: the
/// requested `since` cursor predates the in-memory ring buffer's floor
/// (or the server restarted and lost its buffer). Callers should treat
/// this as "the change feed can't help you; do a full re-enumeration."
public struct StaleCursorError: Error, Sendable, Equatable {
    public let current: Int64

    public init(current: Int64) {
        self.current = current
    }
}

extension RemoteCatalog {
    /// GET /api/changes?since=N&limit=M — polling form. Returns a page
    /// of changes strictly after `since`, in cursor order, capped at
    /// `limit`.
    ///
    /// Throws `StaleCursorError` on HTTP 409; throws on other non-2xx.
    public func listChanges(since: Int64, limit: Int = 100) async throws -> ChangesPage {
        var comps = URLComponents(
            url: server.appending(path: "/api/changes"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [
            .init(name: "since", value: String(since)),
            .init(name: "limit", value: String(limit)),
        ]
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 409 {
            struct Body: Decodable { let current: Int64 }
            // Decoder failures fall through to `check2xx` below — we
            // don't want a malformed 409 body to throw a JSONError.
            if let body = try? JSONDecoder().decode(Body.self, from: data) {
                throw StaleCursorError(current: body.current)
            }
        }
        try Self.check2xx(resp)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(ChangesPage.self, from: data)
    }

    /// GET /api/assets — list endpoint with the three working-set
    /// filters (favourites, xmp-bearing, recent). Passing nil for a
    /// filter omits it; `limit` defaults to 1000 (max 20 000 server-side).
    public func listAssets(
        hasXMP: Bool? = nil,
        ratingGTE: Int? = nil,
        capturedAfter: Date? = nil,
        limit: Int = 1000
    ) async throws -> AssetListResponse {
        var comps = URLComponents(
            url: server.appending(path: "/api/assets"),
            resolvingAgainstBaseURL: false
        )!
        var items: [URLQueryItem] = []
        if hasXMP == true { items.append(.init(name: "has_xmp", value: "1")) }
        if let r = ratingGTE { items.append(.init(name: "rating_gte", value: String(r))) }
        if let d = capturedAfter {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime]
            items.append(.init(name: "captured_after", value: iso.string(from: d)))
        }
        items.append(.init(name: "limit", value: String(limit)))
        comps.queryItems = items
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try JSONDecoder().decode(AssetListResponse.self, from: data)
    }
}
