// Sources/MapleBackup/UploadClient.swift
//
// Chunked + resumable HTTPS upload to the Maple Cloud ingest endpoint.
// The resume key (device_id, phasset_local_id) is in headers on every
// request. The server enforces invariants (end >= start, end < total,
// body length matches range) and returns 409 with expected_offset on
// resume-offset mismatch. On 423 the server tells us another device is
// actively uploading the same iCloud photo — caller should back off and
// requeue without burning a retry slot.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §13.
// Server contract: src/api/src/routes/backup-ingest.ts (PR #27).

import Foundation
import os

public actor UploadClient {

    /// Unified-logging channel for backup upload failures. Surfaces in
    /// Console.app / `log stream --predicate 'category == "upload"'` with
    /// the full failure context (status code, response body snippet,
    /// chunk offset, URL) that `UploadError`'s stringification can't carry
    /// across the actor boundary into `BackupEngine`'s SQLite row.
    ///
    /// **Privacy policy** (matters because sysdiagnose / device sharing
    /// makes these logs portable):
    /// - Public: HTTP status, byte offsets/totals, endpoint URL (hostname
    ///   + path template — no per-asset identifiers).
    /// - Private: `phassetLocalId` (maps to a Photos library entry),
    ///   `targetRelPath` (the user's folder structure), and the response
    ///   `body` snippet (can echo server-side path info / stack traces).
    ///   These render as `<private>` in shared logs unless the dev has a
    ///   `com.apple.system.logging` profile installed for active debugging.
    private static let logger = Logger(
        subsystem: "app.justmaple.aperture", category: "upload")

    public struct Result: Sendable {
        public let mapleId: String
        public let targetRelPath: String
    }

    public enum UploadError: Error, Equatable, Sendable, CustomStringConvertible {
        /// Server returned a non-2xx HTTP status. `body` is a truncated
        /// (≤512 byte) UTF-8 snippet of the response body when available;
        /// it is what makes the failure debuggable in the queue's persisted
        /// `lastError` column (which receives `"\(error)"`).
        case httpError(statusCode: Int, body: String?)
        /// Protocol violation by the server (non-HTTP response, 200 on a
        /// final-chunk-only path, loop exited without success, etc.).
        /// `reason` describes which invariant broke and at what offset.
        case badResponse(reason: String)
        case resumeMismatchNoOffset
        case emptyAsset
        /// Another device on the same iCloud library is actively uploading
        /// this asset. `retryAfterSeconds` is the server's hint for how long
        /// before the peer goes stale — the engine sleeps the task for at
        /// most this long (capped) and re-enqueues at the same priority
        /// without burning a retry slot.
        case busyElsewhere(retryAfterSeconds: TimeInterval)

        public var description: String {
            switch self {
            case .httpError(let code, let body):
                if let body, !body.isEmpty {
                    return "httpError(\(code)): \(body)"
                }
                return "httpError(\(code))"
            case .badResponse(let reason):
                return "badResponse: \(reason)"
            case .resumeMismatchNoOffset:
                return "resumeMismatchNoOffset"
            case .emptyAsset:
                return "emptyAsset"
            case .busyElsewhere(let s):
                return "busyElsewhere(retryAfter=\(s)s)"
            }
        }
    }

    /// UTF-8 decode + truncate a response body for inclusion in error
    /// payloads and log lines. The cap is in **bytes** (≤`max`), not
    /// characters — the snippet may contain fewer Unicode scalars
    /// depending on encoding. Returns `nil` for empty bodies. Genuine
    /// binary payloads produce a `<binary N bytes>` marker so the log
    /// still records "we saw N bytes" without spilling raw bytes.
    ///
    /// A byte truncation can land mid-UTF-8-sequence (UTF-8 scalars are
    /// 1–4 bytes), which would make strict decoding reject a perfectly
    /// good text response. Walk back up to 3 bytes to find a valid
    /// boundary before declaring the response binary.
    private static func bodySnippet(_ data: Data, max: Int = 512) -> String? {
        guard !data.isEmpty else { return nil }
        let take = Swift.min(max, data.count)
        for slack in 0...3 {
            let end = take - slack
            guard end > 0 else { break }
            if let text = String(data: data.prefix(end), encoding: .utf8) {
                return data.count > max ? "\(text)…" : text
            }
        }
        return "<binary \(data.count) bytes>"
    }

    private let baseURL: URL
    private let libraryId: String
    private let deviceId: String
    /// Authenticated transport. In the app this is
    /// `AuthenticatedHTTPClient.data(for:)` (Bearer + 401-refresh-retry);
    /// required so a construction site can't silently skip auth (#855).
    private let transport: AuthorizingTransport

    /// 4 MiB default. Test helpers and the engine can tune via `setChunkSize`.
    private(set) public var chunkSize: Int = 4 * 1024 * 1024

    public init(baseURL: URL, libraryId: String, deviceId: String,
                transport: @escaping AuthorizingTransport) {
        self.baseURL = baseURL
        self.libraryId = libraryId
        self.deviceId = deviceId
        self.transport = transport
    }

    public func setChunkSize(_ newValue: Int) {
        precondition(newValue > 0, "chunkSize must be > 0")
        self.chunkSize = newValue
    }

    /// Upload an XMP sidecar string to the sidecar endpoint.
    /// POSTs the XMP body with device / asset / path headers. The server
    /// writes `<targetRelPath>.xmp` next to the asset bytes.
    ///
    /// - Parameter mapleId: Content-hash dedup key, sent as `X-Maple-Id`. The
    ///   server uses it as the primary asset lookup so content-duplicate /
    ///   re-imported photos (whose `phasset_link` for this device was never
    ///   attached) resolve instead of 404'ing (#698). Optional for callers
    ///   that don't have it; the server falls back to device+phasset.
    public func uploadSidecar(
        phassetLocalId: String,
        targetRelPath: String,
        xmp: String,
        mapleId: String? = nil
    ) async throws {
        let url = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("libraries")
            .appendingPathComponent(libraryId)
            .appendingPathComponent("backup")
            .appendingPathComponent("sidecar")

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(deviceId, forHTTPHeaderField: "X-Maple-Device-Id")
        req.setValue(phassetLocalId, forHTTPHeaderField: "X-Maple-Phasset-Id")
        req.setValue(targetRelPath, forHTTPHeaderField: "X-Maple-Target-Rel-Path")
        if let mapleId { req.setValue(mapleId, forHTTPHeaderField: "X-Maple-Id") }
        req.httpBody = Data(xmp.utf8)

        let (data, response) = try await transport(req)
        guard let http = response as? HTTPURLResponse else {
            Self.logger.error(
                "sidecar non-HTTP response url=\(url, privacy: .public) phasset=\(phassetLocalId, privacy: .private) targetRelPath=\(targetRelPath, privacy: .private)")
            throw UploadError.badResponse(reason: "non-HTTP response from sidecar endpoint")
        }
        guard (200..<300).contains(http.statusCode) else {
            let snippet = Self.bodySnippet(data)
            Self.logger.error(
                "sidecar http=\(http.statusCode) url=\(url, privacy: .public) phasset=\(phassetLocalId, privacy: .private) targetRelPath=\(targetRelPath, privacy: .private) body=\(snippet ?? "<none>", privacy: .private)")
            throw UploadError.httpError(statusCode: http.statusCode, body: snippet)
        }
    }

    /// Upload `bytes` to the ingest endpoint, splitting into `chunkSize`
    /// chunks. The final chunk carries `X-Maple-Maple-Id` for dedup;
    /// intermediate chunks return 202 with `next_offset` and the loop
    /// continues.
    ///
    /// - Parameter onProgress: Optional per-chunk callback. Invoked after each
    ///   accepted chunk with the cumulative bytes sent and total bytes. The
    ///   default is `nil` (no callback) for backward compatibility.
    public func upload(phassetLocalId: String,
                       filename: String,
                       captureDate: Date,
                       lat: Double?,
                       lon: Double?,
                       bytes: Data,
                       mapleId: String,
                       phassetCloudId: String? = nil,
                       onProgress: (@Sendable (_ sent: Int64, _ total: Int64) async -> Void)? = nil) async throws -> Result {
        let total = Int64(bytes.count)
        guard total > 0 else {
            throw UploadError.emptyAsset
        }
        var offset: Int64 = 0
        var fullOffsetRestarts = 0
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
            if let phassetCloudId {
                req.setValue(phassetCloudId, forHTTPHeaderField: "X-Maple-PHAsset-Cloud-Id")
            }
            req.setValue(iso8601.string(from: captureDate), forHTTPHeaderField: "X-Maple-Capture-Date")
            req.setValue(filename, forHTTPHeaderField: "X-Maple-Filename")
            req.setValue(String(total), forHTTPHeaderField: "X-Maple-Total-Bytes")
            if let lat { req.setValue(String(lat), forHTTPHeaderField: "X-Maple-Lat") }
            if let lon { req.setValue(String(lon), forHTTPHeaderField: "X-Maple-Lon") }
            if isFinal { req.setValue(mapleId, forHTTPHeaderField: "X-Maple-Maple-Id") }
            req.httpBody = chunk

            let (data, response) = try await transport(req)
            guard let http = response as? HTTPURLResponse else {
                Self.logger.error(
                    "ingest non-HTTP response url=\(ingestURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) range=\(offset)-\(chunkEnd)/\(total)")
                throw UploadError.badResponse(
                    reason: "non-HTTP response from ingest at \(offset)-\(chunkEnd)/\(total)")
            }

            switch http.statusCode {
            case 409:
                // Server says our resume offset is wrong; trust its `expected_offset`.
                // Special-case `expected_offset == total`: the server thinks all
                // bytes are already there, but if the session were genuinely
                // complete we'd have hit the `alreadyComplete` 200 short-circuit
                // path instead. The only consistent reading is "disk/DB desync"
                // (e.g. the server cleared its chunk dir at boot but the Mongo
                // row still had received_bytes == total). Restart from 0 rather
                // than fall out of the loop without a result.
                struct Mismatch: Decodable { let expected_offset: Int64? }
                if let body = try? JSONDecoder().decode(Mismatch.self, from: data),
                   let newOffset = body.expected_offset {
                    if newOffset >= total {
                        guard fullOffsetRestarts == 0 else {
                            Self.logger.error(
                                "ingest repeated 409 expected_offset>=total — aborting url=\(ingestURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) expected=\(newOffset) total=\(total)")
                            throw UploadError.badResponse(
                                reason: "repeated ingest 409 expected_offset=\(newOffset) total=\(total)")
                        }
                        fullOffsetRestarts += 1
                        Self.logger.notice(
                            "ingest 409 expected_offset>=total — restarting from 0 url=\(ingestURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) expected=\(newOffset) total=\(total)")
                        offset = 0
                    } else {
                        offset = newOffset
                    }
                    continue
                }
                Self.logger.error(
                    "ingest 409 without expected_offset url=\(ingestURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) range=\(offset)-\(chunkEnd)/\(total) body=\(Self.bodySnippet(data) ?? "<none>", privacy: .private)")
                throw UploadError.resumeMismatchNoOffset
            case 423:
                // Another device is actively uploading this asset. Surface
                // the back-off hint so the engine can requeue without
                // burning a retry slot.
                struct Busy: Decodable { let retry_after_seconds: Double? }
                let body = try? JSONDecoder().decode(Busy.self, from: data)
                throw UploadError.busyElsewhere(
                    retryAfterSeconds: body?.retry_after_seconds ?? 60)
            case 202:
                guard !isFinal else {
                    Self.logger.error(
                        "ingest 202 on final chunk url=\(ingestURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) range=\(offset)-\(chunkEnd)/\(total)")
                    throw UploadError.badResponse(
                        reason: "202 on final chunk \(offset)-\(chunkEnd)/\(total) — expected 200 with maple_id")
                }
                offset = chunkEnd + 1
                if let onProgress { await onProgress(offset, total) }
            case 200:
                // 200 on the final chunk is the normal success path. 200 on
                // any earlier chunk means the server recognised this as a
                // retry-after-completed and short-circuited (an earlier
                // attempt finished ingest but a downstream step — sidecar /
                // rendered / live — failed and re-enqueued the task). The
                // body still carries the maple_id + target_rel_path the
                // engine needs to proceed with sidecar/rendered uploads.
                if let onProgress { await onProgress(total, total) }
                struct Final: Decodable { let maple_id: String; let target_rel_path: String }
                let body = try JSONDecoder().decode(Final.self, from: data)
                return Result(mapleId: body.maple_id, targetRelPath: body.target_rel_path)
            default:
                let snippet = Self.bodySnippet(data)
                Self.logger.error(
                    "ingest http=\(http.statusCode) url=\(ingestURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) range=\(offset)-\(chunkEnd)/\(total) body=\(snippet ?? "<none>", privacy: .private)")
                throw UploadError.httpError(statusCode: http.statusCode, body: snippet)
            }
        }
        Self.logger.error(
            "ingest loop exited without success url=\(ingestURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) offset=\(offset) total=\(total)")
        throw UploadError.badResponse(
            reason: "ingest loop exited offset=\(offset) total=\(total)")
    }

    /// Upload an Apple-rendered companion or Live Photo .mov twin via the
    /// rendered endpoint using the same chunked+resumable pattern.
    ///
    /// - Parameter onProgress: Optional per-chunk callback, same shape as
    ///   `upload(onProgress:)`. Default is `nil`.
    /// - Parameter suffixOverride: When set, the `X-Maple-Suffix-Override`
    ///   header is sent and the server names the file `<base>.<suffixOverride>`
    ///   instead of `<base>.rendered.<ext>`. Used by the Live Photo .mov path
    ///   so the twin lands as `<base>.mov` without the `.rendered.` infix.
    /// - Parameter phassetCloudId: Apple PHCloudIdentifier, when available.
    ///   Sent as `X-Maple-PHAsset-Cloud-Id` so the server can detect when
    ///   two devices on the same iCloud library both try to upload the
    ///   rendered companion for the same photo and return 423 to the
    ///   second one.
    public func uploadRendered(
        phassetLocalId: String,
        targetRelPath: String,
        filenameExt: String,
        bytes: Data,
        onProgress: (@Sendable (_ sent: Int64, _ total: Int64) async -> Void)? = nil,
        suffixOverride: String? = nil,
        phassetCloudId: String? = nil
    ) async throws {
        let total = Int64(bytes.count)
        guard total > 0 else { return }
        var offset: Int64 = 0
        var fullOffsetRestarts = 0
        let renderedURL = baseURL
            .appendingPathComponent("api")
            .appendingPathComponent("libraries")
            .appendingPathComponent(libraryId)
            .appendingPathComponent("backup")
            .appendingPathComponent("rendered")

        while offset < total {
            let chunkEnd = min(offset + Int64(chunkSize), total) - 1
            let chunk = bytes.subdata(in: Int(offset)..<Int(chunkEnd + 1))
            let isFinal = chunkEnd + 1 == total

            var req = URLRequest(url: renderedURL)
            req.httpMethod = "POST"
            req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            req.setValue("bytes \(offset)-\(chunkEnd)/\(total)", forHTTPHeaderField: "Content-Range")
            req.setValue(deviceId, forHTTPHeaderField: "X-Maple-Device-Id")
            req.setValue(phassetLocalId, forHTTPHeaderField: "X-Maple-Phasset-Id")
            req.setValue(targetRelPath, forHTTPHeaderField: "X-Maple-Target-Rel-Path")
            req.setValue(filenameExt, forHTTPHeaderField: "X-Maple-Rendered-Ext")
            req.setValue(String(total), forHTTPHeaderField: "X-Maple-Total-Bytes")
            if let suffixOverride {
                req.setValue(suffixOverride, forHTTPHeaderField: "X-Maple-Suffix-Override")
            }
            if let phassetCloudId {
                req.setValue(phassetCloudId, forHTTPHeaderField: "X-Maple-PHAsset-Cloud-Id")
            }
            req.httpBody = chunk

            let (data, response) = try await transport(req)
            guard let http = response as? HTTPURLResponse else {
                Self.logger.error(
                    "rendered non-HTTP response url=\(renderedURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) targetRelPath=\(targetRelPath, privacy: .private) range=\(offset)-\(chunkEnd)/\(total)")
                throw UploadError.badResponse(
                    reason: "non-HTTP response from rendered at \(offset)-\(chunkEnd)/\(total)")
            }

            switch http.statusCode {
            case 409:
                // Same disk/DB-desync handling as `upload(...)`: if the server
                // claims we already sent everything (expected_offset >= total)
                // but didn't short-circuit to 200, restart from 0.
                struct Mismatch: Decodable { let expected_offset: Int64? }
                if let body = try? JSONDecoder().decode(Mismatch.self, from: data),
                   let newOffset = body.expected_offset {
                    if newOffset >= total {
                        guard fullOffsetRestarts == 0 else {
                            Self.logger.error(
                                "rendered repeated 409 expected_offset>=total — aborting url=\(renderedURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) expected=\(newOffset) total=\(total)")
                            throw UploadError.badResponse(
                                reason: "repeated rendered 409 expected_offset=\(newOffset) total=\(total)")
                        }
                        fullOffsetRestarts += 1
                        Self.logger.notice(
                            "rendered 409 expected_offset>=total — restarting from 0 url=\(renderedURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) expected=\(newOffset) total=\(total)")
                        offset = 0
                    } else {
                        offset = newOffset
                    }
                    continue
                }
                Self.logger.error(
                    "rendered 409 without expected_offset url=\(renderedURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) targetRelPath=\(targetRelPath, privacy: .private) range=\(offset)-\(chunkEnd)/\(total) body=\(Self.bodySnippet(data) ?? "<none>", privacy: .private)")
                throw UploadError.resumeMismatchNoOffset
            case 423:
                struct Busy: Decodable { let retry_after_seconds: Double? }
                let body = try? JSONDecoder().decode(Busy.self, from: data)
                throw UploadError.busyElsewhere(
                    retryAfterSeconds: body?.retry_after_seconds ?? 60)
            case 202:
                guard !isFinal else {
                    Self.logger.error(
                        "rendered 202 on final chunk url=\(renderedURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) targetRelPath=\(targetRelPath, privacy: .private) range=\(offset)-\(chunkEnd)/\(total)")
                    throw UploadError.badResponse(
                        reason: "202 on final rendered chunk \(offset)-\(chunkEnd)/\(total) — expected 200")
                }
                offset = chunkEnd + 1
                if let onProgress { await onProgress(offset, total) }
            case 200:
                // Same semantic as `upload(...)`: 200 on any chunk position
                // means the rendered companion is already complete server-
                // side. The body carries `{ target_rel_path }` but the
                // caller discards the return value, so no parsing needed.
                if let onProgress { await onProgress(total, total) }
                return
            default:
                let snippet = Self.bodySnippet(data)
                Self.logger.error(
                    "rendered http=\(http.statusCode) url=\(renderedURL, privacy: .public) phasset=\(phassetLocalId, privacy: .private) targetRelPath=\(targetRelPath, privacy: .private) range=\(offset)-\(chunkEnd)/\(total) body=\(snippet ?? "<none>", privacy: .private)")
                throw UploadError.httpError(statusCode: http.statusCode, body: snippet)
            }
        }
    }
}
