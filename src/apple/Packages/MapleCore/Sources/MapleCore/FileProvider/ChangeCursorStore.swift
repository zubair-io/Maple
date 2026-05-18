/**
 ChangeCursorStore — persists the last-seen server cursor per
 File Provider domain (Phase 5b, hardened in Phase 6 item 3).

 The extension reconnects to /api/changes/subscribe on every launch /
 SSE-failure with `?since=<load(domain:)>`, so loss of state forces a
 full re-enumeration via the 409 stale-cursor path. Persistence here
 keeps that path rare.

 Storage: one small file per domain under the App Group container at
 `~/Library/Group Containers/<appGroup>/ChangeCursor/<domain>.cursor`.

 Cross-process atomicity uses `NSFileCoordinator` to serialise the
 entire read-modify-write window. `Data.write(.atomic)` alone makes
 only the WRITE atomic — two processes racing on RMW can both read
 the same baseline, each compute max(baseline, their_value), and the
 lower of those maxes can win the `rename(2)` and clobber the higher
 cursor. `NSFileCoordinator` is Apple's standard primitive for App
 Group file coordination; coordinated readers and writers on the same
 URL serialise across process boundaries.

 The in-process `NSLock` is retained as a fast path for same-process
 threads (coordinator round-trips are heavier than a contended
 NSLock).
 */

import Foundation
import OSLog

private let cursorLogger = Logger(
    subsystem: "app.justmaple.aperture.fileprovider",
    category: "cursor-store"
)

public final class ChangeCursorStore: @unchecked Sendable {
    private let directory: URL
    private let lock = NSLock()

    /// `directory` overrides the App Group container — used by tests so
    /// they don't pollute the real shared store. When omitted, resolves
    /// `~/Library/Group Containers/<appGroupSuiteName>/ChangeCursor/`.
    /// If the App Group container is unavailable (entitlement missing /
    /// sandboxed away) falls back to a temp directory; saves still work
    /// in-process but cross-process visibility is lost — the same
    /// degraded-but-not-crashing posture `FileProviderConfig` takes.
    public init(directory: URL? = nil) {
        if let d = directory {
            self.directory = d
        } else if let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: FileProviderConfig.appGroupSuiteName
        ) {
            self.directory = container.appendingPathComponent(
                "ChangeCursor", isDirectory: true
            )
        } else {
            cursorLogger.error(
                "App Group container \(FileProviderConfig.appGroupSuiteName, privacy: .public) unavailable — falling back to NSTemporaryDirectory; extension will not see writes"
            )
            self.directory = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("MapleChangeCursor-fallback", isDirectory: true)
        }
        try? FileManager.default.createDirectory(
            at: self.directory, withIntermediateDirectories: true
        )
    }

    /// Last-seen cursor for `domain`, or 0 if the domain has never
    /// received an event (or the file is missing / unreadable).
    ///
    /// Reads are coordinated via `NSFileCoordinator` so a load that
    /// races a concurrent save in another process sees the post-write
    /// value (or the pre-write value) — never a partially-written
    /// state. The in-process `NSLock` is held across the coordinator
    /// call to keep same-process readers behind same-process writers.
    public func load(domain: String) -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        let url = fileURL(for: domain)
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordErr: NSError?
        var result: Int64 = 0
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordErr) { coordinatedURL in
            result = readFile(at: coordinatedURL)
        }
        if let coordErr {
            cursorLogger.error(
                "load coordinator failed for domain \(domain, privacy: .public): \(coordErr.localizedDescription, privacy: .public)"
            )
        }
        return result
    }

    /// Persists `cursor` for `domain`, but only if it is greater than
    /// the currently-persisted value — the cursor must never regress.
    ///
    /// The entire read-modify-write window runs inside an
    /// `NSFileCoordinator` `coordinate(writingItemAt:)` block, which
    /// serialises against any other coordinated reader or writer on
    /// the same URL across processes. This is the inter-process
    /// equivalent of the in-process `NSLock` — without it, two
    /// processes can both read baseline X, both compute max(X, their),
    /// and whichever `rename(2)` wins overwrites the other's max even
    /// if it was lower (because both maxes only saw the pre-write
    /// baseline, not each other).
    public func save(_ cursor: Int64, domain: String) {
        lock.lock()
        defer { lock.unlock() }
        let url = fileURL(for: domain)
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordErr: NSError?
        coordinator.coordinate(writingItemAt: url, options: [], error: &coordErr) { coordinatedURL in
            let onDisk = readFile(at: coordinatedURL)
            let winner = max(onDisk, cursor)
            if winner == onDisk { return }
            writeFile(winner, at: coordinatedURL, domain: domain)
        }
        if let coordErr {
            cursorLogger.error(
                "save coordinator failed for domain \(domain, privacy: .public): \(coordErr.localizedDescription, privacy: .public)"
            )
        }
    }

    public func reset(domain: String) {
        lock.lock()
        defer { lock.unlock() }
        let url = fileURL(for: domain)
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordErr: NSError?
        coordinator.coordinate(writingItemAt: url, options: .forDeleting, error: &coordErr) { coordinatedURL in
            try? FileManager.default.removeItem(at: coordinatedURL)
        }
        if let coordErr {
            cursorLogger.error(
                "reset coordinator failed for domain \(domain, privacy: .public): \(coordErr.localizedDescription, privacy: .public)"
            )
        }
    }

    // MARK: - Internals (must be called inside the coordinator block)

    private func readFile(at url: URL) -> Int64 {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else {
            return 0
        }
        return Int64(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }

    private func writeFile(_ cursor: Int64, at url: URL, domain: String) {
        let payload = "\(cursor)\n".data(using: .utf8) ?? Data()
        do {
            try payload.write(to: url, options: .atomic)
        } catch {
            cursorLogger.error(
                "write failed for domain \(domain, privacy: .public): \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    /// Per-domain file. Domain identifiers in this codebase are UUIDs /
    /// short ascii, but defensively percent-encode anything outside
    /// `[A-Za-z0-9._-]` to prevent a stray `/` or `..` escaping the
    /// directory.
    ///
    /// Non-ASCII scalars are encoded as their UTF-8 byte sequence (each
    /// byte percent-encoded). Truncating the scalar value to one byte
    /// (`& 0xFF`) would collide distinct scalars sharing a low byte
    /// (e.g. U+00E4 and U+01E4 both → `%E4`), letting two domains share
    /// a single cursor file.
    private func fileURL(for domain: String) -> URL {
        var safe = ""
        for scalar in domain.unicodeScalars {
            let v = scalar.value
            if (v >= 0x30 && v <= 0x39)   // 0-9
                || (v >= 0x41 && v <= 0x5A) // A-Z
                || (v >= 0x61 && v <= 0x7A) // a-z
                || v == 0x2E || v == 0x2D || v == 0x5F { // . - _
                safe.append(Character(scalar))
            } else {
                for byte in String(scalar).utf8 {
                    safe.append(String(format: "%%%02X", byte))
                }
            }
        }
        return directory.appendingPathComponent("\(safe).cursor")
    }
}
