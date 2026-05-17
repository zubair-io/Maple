// src/apple/MapleFileProvider/ChangeFeedClient.swift
//
// Subscribes to /api/changes/subscribe (SSE) and signals the FP
// working-set enumerator on each event. Reconnects on failure with
// exponential backoff capped at 16 s. Resumes from the last-seen
// cursor via the `?since=` query param.
//
// One instance per FP domain; owned by FileProviderExtension.

import Foundation
import FileProvider
import MapleCore
import OSLog

final class ChangeFeedClient {
    private let server: URL
    private let tokensProvider: @Sendable () -> AuthTokens?
    private let cursorStore: ChangeCursorStore
    private let domainID: String
    private let onEvent: @Sendable (AssetChange) async -> Void
    /// Called when the server returns 409 with its `current` cursor.
    /// The extension uses this to signal `.workingSet` so the OS does a
    /// full re-enumeration. Optional so tests can inject without
    /// touching `NSFileProviderManager`.
    private let onStaleCursor: (@Sendable (Int64) async -> Void)?
    /// Optional reference to the catalog. When the server tells us our
    /// cursor is stale (409), the in-memory ETag cache is by definition
    /// also stale — purging it forces the next `/api/folders` and
    /// `/api/fs/dir` round trip to be a full fetch rather than a 304-
    /// short-circuited reuse of pre-409 bodies.
    private let catalog: RemoteCatalog?
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider",
                             category: "change-feed")
    private var task: Task<Void, Never>?

    init(server: URL,
         tokensProvider: @escaping @Sendable () -> AuthTokens?,
         cursorStore: ChangeCursorStore,
         domainID: String,
         catalog: RemoteCatalog? = nil,
         onEvent: @escaping @Sendable (AssetChange) async -> Void,
         onStaleCursor: (@Sendable (Int64) async -> Void)? = nil) {
        self.server = server
        self.tokensProvider = tokensProvider
        self.cursorStore = cursorStore
        self.domainID = domainID
        self.catalog = catalog
        self.onEvent = onEvent
        self.onStaleCursor = onStaleCursor
    }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.runForever() }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    private func runForever() async {
        var backoffNs: UInt64 = 2_000_000_000  // 2s
        let maxBackoffNs: UInt64 = 16_000_000_000
        while !Task.isCancelled {
            do {
                try await runOneConnection()
                // Clean server close — reset backoff for the retry.
                backoffNs = 2_000_000_000
            } catch is CancellationError {
                return
            } catch {
                log.notice("SSE connection ended: \(error.localizedDescription, privacy: .public)")
                try? await Task.sleep(nanoseconds: backoffNs)
                backoffNs = min(backoffNs * 2, maxBackoffNs)
            }
        }
    }

    private func runOneConnection() async throws {
        let since = cursorStore.load(domain: domainID)
        var comps = URLComponents(
            url: server.appending(path: "/api/changes/subscribe"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [.init(name: "since", value: String(since))]
        var req = URLRequest(url: comps.url!)
        req.timeoutInterval = 0  // indefinite — SSE
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        if let tok = tokensProvider() {
            req.setValue("Bearer \(tok.access)", forHTTPHeaderField: "Authorization")
        }

        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 409 {
            // Server tells us our cursor is below the buffer floor.
            // Old behaviour was `cursorStore.reset(domain:)`, which
            // pushed since back to 0 — on a server that has had many
            // events, since=0 ALSO trips the 409 path, so the client
            // livelocked reconnecting. Instead:
            //
            //   1. Read the server's `current` cursor from the 409 body
            //      and jump to it. We've missed every event between our
            //      stale `since` and `current`, so step (3) reconciles.
            //   2. Drop the RemoteCatalog ETag cache — its entries
            //      reflect the pre-gap state and a 304 against them
            //      after a force-reseed would serve a stale folder list.
            //   3. Trigger working-set re-enumeration via the host's
            //      `onStaleCursor` callback (FileProviderExtension
            //      signals `.workingSet` so the OS pulls fresh state).
            //
            // The 409 body shape mirrors `StaleCursorError` (see
            // RemoteCatalog+Changes.swift): `{ "error": ..., "current": N }`.
            // A malformed body falls back to a reset; the worst-case
            // recovery is one more 409 cycle that hits the same path.
            var serverCurrent: Int64 = 0
            var bodyBytes = Data()
            for try await byte in bytes {
                bodyBytes.append(byte)
                if bodyBytes.count > 4096 { break }
            }
            struct StaleBody: Decodable { let current: Int64? }
            if let parsed = try? JSONDecoder().decode(StaleBody.self, from: bodyBytes),
               let current = parsed.current {
                serverCurrent = current
            }
            log.notice("SSE 409 stale cursor; advancing to server current=\(serverCurrent)")
            if serverCurrent > 0 {
                cursorStore.save(serverCurrent, domain: domainID)
            } else {
                cursorStore.reset(domain: domainID)
            }
            await catalog?.invalidateETagCache()
            await onStaleCursor?(serverCurrent)
            return
        }
        guard (200..<300).contains(code) else {
            throw URLError(.badServerResponse)
        }

        // Parse SSE line-by-line. Spec: events end with a blank line.
        // Multi-line `data:` fields are concatenated with embedded \n.
        var dataBuffer = ""
        var idBuffer: String?
        for try await line in bytes.lines {
            if Task.isCancelled { return }
            if line.isEmpty {
                if !dataBuffer.isEmpty {
                    if let ev = decodeEvent(dataBuffer) {
                        // J: dispatch BEFORE we persist the cursor.
                        // Previously the save ran first and any crash /
                        // throw inside `onEvent` would leave the cursor
                        // advanced past an event that never landed in
                        // the working set, losing it forever. Saving
                        // after a successful await means a crash here
                        // replays the event on next reconnect.
                        await onEvent(ev)
                        if let idStr = idBuffer, let id = Int64(idStr) {
                            cursorStore.save(id, domain: domainID)
                        }
                    }
                }
                dataBuffer = ""
                idBuffer = nil
                continue
            }
            if line.hasPrefix(":") { continue }  // comment / keepalive
            if line.hasPrefix("id:") {
                idBuffer = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let chunk = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                dataBuffer = dataBuffer.isEmpty
                    ? String(chunk)
                    : dataBuffer + "\n" + chunk
            }
        }
    }

    private func decodeEvent(_ data: String) -> AssetChange? {
        guard let raw = data.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(AssetChange.self, from: raw)
    }
}
