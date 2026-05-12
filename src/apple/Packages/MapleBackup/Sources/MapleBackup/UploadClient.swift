// Sources/MapleBackup/UploadClient.swift
//
// Chunked + resumable HTTPS upload to the Maple Cloud ingest endpoint.
// The resume key (device_id, phasset_local_id) is in headers on every
// request. The server enforces invariants (end >= start, end < total,
// body length matches range) and returns 409 with expected_offset on
// resume-offset mismatch.
//
// Spec: docs/superpowers/specs/2026-05-09-photokit-backup-design.md §13.
// Server contract: src/api/src/routes/backup-ingest.ts (PR #27).

import Foundation

public actor UploadClient {

    public struct Result: Sendable {
        public let mapleId: String
        public let targetRelPath: String
    }

    public enum UploadError: Error, Equatable, Sendable {
        case httpError(Int)
        case badResponse
        case resumeMismatchNoOffset
    }

    private let baseURL: URL
    private let libraryId: String
    private let deviceId: String
    private let session: URLSession

    /// 4 MiB default. Test helpers and the engine can tune via `setChunkSize`.
    private(set) public var chunkSize: Int = 4 * 1024 * 1024

    public init(baseURL: URL, libraryId: String, deviceId: String,
                session: URLSession = .shared) {
        self.baseURL = baseURL
        self.libraryId = libraryId
        self.deviceId = deviceId
        self.session = session
    }

    public func setChunkSize(_ newValue: Int) {
        precondition(newValue > 0, "chunkSize must be > 0")
        self.chunkSize = newValue
    }

    /// Upload `bytes` to the ingest endpoint, splitting into `chunkSize`
    /// chunks. The final chunk carries `X-Maple-Maple-Id` for dedup;
    /// intermediate chunks return 202 with `next_offset` and the loop
    /// continues.
    public func upload(phassetLocalId: String,
                       filename: String,
                       captureDate: Date,
                       lat: Double?,
                       lon: Double?,
                       bytes: Data,
                       mapleId: String) async throws -> Result {
        let total = Int64(bytes.count)
        var offset: Int64 = 0
        let ingestURL = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("libraries")
            .appendingPathComponent(libraryId)
            .appendingPathComponent("backup")
            .appendingPathComponent("ingest")

        let iso8601 = ISO8601DateFormatter()

        while offset < total {
            let chunkEnd = min(offset + Int64(chunkSize), total) - 1
            let chunk = bytes.subdata(in: Int(offset)..<Int(chunkEnd + 1))
            let isFinal = chunkEnd + 1 == total

            var req = URLRequest(url: ingestURL)
            req.httpMethod = "POST"
            req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            req.setValue("bytes \(offset)-\(chunkEnd)/\(total)", forHTTPHeaderField: "Content-Range")
            req.setValue(deviceId, forHTTPHeaderField: "X-Maple-Device-Id")
            req.setValue(phassetLocalId, forHTTPHeaderField: "X-Maple-Phasset-Id")
            req.setValue(iso8601.string(from: captureDate), forHTTPHeaderField: "X-Maple-Capture-Date")
            req.setValue(filename, forHTTPHeaderField: "X-Maple-Filename")
            req.setValue(String(total), forHTTPHeaderField: "X-Maple-Total-Bytes")
            if let lat { req.setValue(String(lat), forHTTPHeaderField: "X-Maple-Lat") }
            if let lon { req.setValue(String(lon), forHTTPHeaderField: "X-Maple-Lon") }
            if isFinal { req.setValue(mapleId, forHTTPHeaderField: "X-Maple-Maple-Id") }
            req.httpBody = chunk

            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { throw UploadError.badResponse }

            switch http.statusCode {
            case 409:
                // Server says our resume offset is wrong; trust its `expected_offset`.
                struct Mismatch: Decodable { let expected_offset: Int64? }
                if let body = try? JSONDecoder().decode(Mismatch.self, from: data),
                   let newOffset = body.expected_offset {
                    offset = newOffset
                    continue
                }
                throw UploadError.resumeMismatchNoOffset
            case 202:
                guard !isFinal else { throw UploadError.badResponse }
                offset = chunkEnd + 1
            case 200:
                guard isFinal else { throw UploadError.badResponse }
                struct Final: Decodable { let maple_id: String; let target_rel_path: String }
                let body = try JSONDecoder().decode(Final.self, from: data)
                return Result(mapleId: body.maple_id, targetRelPath: body.target_rel_path)
            default:
                throw UploadError.httpError(http.statusCode)
            }
        }
        throw UploadError.badResponse
    }
}
