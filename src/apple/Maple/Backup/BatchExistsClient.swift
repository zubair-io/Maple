// src/apple/Maple/Backup/BatchExistsClient.swift
//
// Thin client over POST /api/libraries/:libraryId/backup/exists
//
// Content-level dedup: given a batch of maple_ids, the server returns the
// subset NOT already present in the library. The walk uses this for candidate
// phids that survived PHID reconciliation (BackupStateClient) — it computes
// each candidate's maple_id and only enqueues the ones the server is missing,
// marking the rest `.uploaded` locally. This is what stops a restart from
// re-uploading photos the server already has under a *different* device id (or
// from a folder scan).
//
// Server contract (added in parallel):
//   POST /api/libraries/:libraryId/backup/exists
//   body  { "maple_ids": string[] }        (max 1000 ids per request)
//   200   { "missing": string[] }          (subset NOT already on the server)
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §20.

import Foundation

actor BatchExistsClient {

    /// Server cap per request. The caller chunks larger candidate sets.
    static let maxBatchSize = 1000

    enum BatchError: Error {
        /// The caller passed more than `maxBatchSize` ids in one request.
        case batchTooLarge(count: Int, max: Int)
    }

    private struct RequestBody: Encodable {
        let maple_ids: [String]
    }

    private struct Response: Decodable {
        let missing: [String]
    }

    private let baseURL: URL
    private let libraryId: String
    private let deviceId: String
    private let session: URLSession

    init(baseURL: URL, libraryId: String, deviceId: String,
         session: URLSession = .shared) {
        self.baseURL = baseURL
        self.libraryId = libraryId
        self.deviceId = deviceId
        self.session = session
    }

    /// Ask the server which of `mapleIds` are NOT yet present in this library.
    /// `mapleIds` must be <= `maxBatchSize`. Throws on network failure or
    /// non-200 so the caller can fall back to enqueueing the candidates
    /// (safe: the upload path itself dedups server-side).
    func missing(mapleIds: [String]) async throws -> [String] {
        // Throw rather than trap — this is a network helper whose errors the
        // caller already handles (falls back to enqueueing). A constant drift
        // or an un-chunked call site shouldn't crash the app.
        guard mapleIds.count <= Self.maxBatchSize else {
            throw BatchError.batchTooLarge(count: mapleIds.count, max: Self.maxBatchSize)
        }
        if mapleIds.isEmpty { return [] }

        let endpoint = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("libraries")
            .appendingPathComponent(libraryId)
            .appendingPathComponent("backup")
            .appendingPathComponent("exists")

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(deviceId, forHTTPHeaderField: "X-Maple-Device-Id")
        req.httpBody = try JSONEncoder().encode(RequestBody(maple_ids: mapleIds))

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(Response.self, from: data).missing
    }
}
