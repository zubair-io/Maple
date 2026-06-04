// src/apple/Maple/Backup/BackupStateClient.swift
//
// Thin client over GET /api/libraries/:libraryId/backup/state?device_id=...
//
// Reconciliation feed: returns the assets the server has already recorded for
// this device in this library. The walk (ChangeObserverWiring.enqueueAllNew)
// uses this — BEFORE deciding what to enqueue — to treat server-known phids as
// the authoritative "already backed up" set. Without it, clearing or
// reinstalling the local SQLite state makes a restart re-upload every photo.
//
// Server contract: src/api/src/routes/backup-state.ts
//   200 { assets: [ { phasset_local_id, first_seen, maple_id, rel_path }, ... ] }
//
// Network errors propagate so the caller can choose to skip reconciliation
// (and fall back to local-state-only behaviour) rather than block the walk.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §20.

import Foundation
import MapleBackup

actor BackupStateClient {

    /// One asset the server reports as already backed up for this device.
    struct ServerAsset: Decodable, Sendable {
        let phassetLocalId: String
        let mapleId: String?
        let relPath: String?

        enum CodingKeys: String, CodingKey {
            case phassetLocalId = "phasset_local_id"
            case mapleId = "maple_id"
            case relPath = "rel_path"
        }
    }

    private struct Response: Decodable {
        let assets: [ServerAsset]
    }

    private let baseURL: URL
    private let libraryId: String
    private let deviceId: String
    /// Authenticated transport (#855) — required so the gated `/backup/state`
    /// route isn't hit without a bearer.
    private let transport: AuthorizingTransport

    init(baseURL: URL, libraryId: String, deviceId: String,
         transport: @escaping AuthorizingTransport) {
        self.baseURL = baseURL
        self.libraryId = libraryId
        self.deviceId = deviceId
        self.transport = transport
    }

    /// Fetch the assets the server already has for this device in this library.
    /// Throws on network failure or non-200 so the caller can fall back to
    /// local-state-only reconciliation.
    func fetchKnownAssets() async throws -> [ServerAsset] {
        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("libraries")
            .appendingPathComponent(libraryId)
            .appendingPathComponent("backup")
            .appendingPathComponent("state")
        var comps = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "device_id", value: deviceId)]

        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        req.setValue(deviceId, forHTTPHeaderField: "X-Maple-Device-Id")

        let (data, response) = try await transport(req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(Response.self, from: data).assets
    }
}
