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
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider",
                             category: "change-feed")
    private var task: Task<Void, Never>?

    init(server: URL,
         tokensProvider: @escaping @Sendable () -> AuthTokens?,
         cursorStore: ChangeCursorStore,
         domainID: String,
         onEvent: @escaping @Sendable (AssetChange) async -> Void) {
        self.server = server
        self.tokensProvider = tokensProvider
        self.cursorStore = cursorStore
        self.domainID = domainID
        self.onEvent = onEvent
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
            // Server says our cursor is too old. Reset to 0 and let the
            // next reconnect catch up via replay-from-zero; the
            // working-set enumerator will full-re-enumerate on the next
            // OS poll thanks to the syncAnchorExpired throw.
            log.notice("SSE 409 stale cursor; resetting to 0")
            cursorStore.reset(domain: domainID)
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
                        if let idStr = idBuffer, let id = Int64(idStr) {
                            cursorStore.save(id, domain: domainID)
                        }
                        await onEvent(ev)
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
