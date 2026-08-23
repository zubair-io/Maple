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

    /// GET /api/assets/:id — fetch a single asset's metadata. Used by
    /// `FileProviderExtension.item(for:)` to resolve a bare `.asset(id)`
    /// identifier (e.g. one delivered through `enumerateChanges`) into a
    /// real `MapleItem` with filename + mtime + size. Returns nil on 404
    /// so the caller can map to `noSuchItem` without distinguishing.
    public func getAsset(assetID: String) async throws -> AssetMetadata? {
        try Self.validateAssetID(assetID)
        let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)"))
        let (data, resp) = try await http.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 404 { return nil }
        try Self.check2xx(resp)
        let decoder = JSONDecoder()
        // The server stamps `mtime` in epoch MILLISECONDS for this
        // route (it's a passthrough of `AssetDoc.mtime`). The
        // `/api/assets` list endpoint normalises to seconds; we mirror
        // that conversion here in `AssetMetadata.contentModificationDate`.
        return try decoder.decode(AssetMetadata.self, from: data)
    }

    /// POST /api/assets/batch-meta — bulk form of `getAsset` (#2995).
    /// Resolves a whole change-feed page's asset ids in one round trip
    /// instead of one GET per row (the request storm that pinned the iOS
    /// extension at ~300 req/s while draining a backlog).
    ///
    /// Returns nil when the server predates the route (HTTP 404) so the
    /// caller can fall back to the legacy per-asset GET path — a new
    /// extension must keep working against an old Self Hosted server.
    /// Ids missing from the returned array raced a server-side delete
    /// (the batch equivalent of `getAsset`'s nil-on-404).
    public func getAssetsBatch(assetIDs: [String]) async throws -> [AssetMetadata]? {
        for id in assetIDs { try Self.validateAssetID(id) }
        var req = URLRequest(url: server.appending(path: "/api/assets/batch-meta"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["ids": assetIDs])
        let (data, resp) = try await http.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 404 { return nil }
        try Self.check2xx(resp, data: data, url: req.url)
        struct Batch: Decodable { let assets: [AssetMetadata] }
        return try JSONDecoder().decode(Batch.self, from: data).assets
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
