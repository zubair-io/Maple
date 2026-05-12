// Sources/MapleBackup/GeocodeClient.swift
//
// Thin wrapper over GET /api/geocode/reverse. The device calls this before
// deciding the upload path for a backed-up asset.
//
// Returns:
//   - `pois[0].name` when the cached Place has at least one POI
//   - `rollups.locality` when POIs are empty but a locality is set
//   - nil for 404 (no cache row), 500/etc (unexpected status), or `place`
//     payload with both pois and locality empty
//
// Network errors propagate — the caller (BackupEngine) handles retry.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §9, §20.

import Foundation

public actor GeocodeClient {

    private struct Response: Decodable {
        struct Place: Decodable {
            struct Poi: Decodable { let name: String }
            struct Rollups: Decodable { let locality: String? }
            let pois: [Poi]
            let rollups: Rollups
        }
        let place: Place
    }

    private let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    /// Returns the primary location name for `lat,lon`, or nil when the
    /// geocode cache has no entry or returns an unexpected status.
    /// Throws on network failure so the caller can decide whether to
    /// fall back or retry.
    public func lookup(lat: Double, lon: Double) async throws -> String? {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/geocode/reverse"),
                                  resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "lat", value: String(lat)),
            URLQueryItem(name: "lon", value: String(lon)),
            URLQueryItem(name: "precision", value: "4"),
        ]
        let (data, response) = try await session.data(from: comps.url!)
        guard let http = response as? HTTPURLResponse else { return nil }
        if http.statusCode == 404 { return nil }
        guard http.statusCode == 200 else { return nil }
        let decoded = try JSONDecoder().decode(Response.self, from: data)
        if let first = decoded.place.pois.first { return first.name }
        return decoded.place.rollups.locality
    }
}
