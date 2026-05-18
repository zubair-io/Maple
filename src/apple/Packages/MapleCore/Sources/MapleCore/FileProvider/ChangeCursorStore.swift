/**
 ChangeCursorStore — persists the last-seen server cursor per
 File Provider domain (Phase 5b, hardened in Phase 6 item 3).

 The extension reconnects to /api/changes/subscribe on every launch /
 SSE-failure with `?since=<load(domain:)>`, so loss of state forces a
 full re-enumeration via the 409 stale-cursor path. Persistence here
 keeps that path rare.

 Storage: one small file per domain under the App Group container at
 `~/Library/Group Containers/<appGroup>/ChangeCursor/<domain>.cursor`.
 Saves do read → max → atomic write (`Data.write(.atomic)` performs
 write-tmp + `rename(2)` under the hood). POSIX `rename` is atomic
 across processes on APFS, so two processes racing both end up with
 the higher cursor regardless of which `rename` won — the max-check
 each performed guarantees the winning value is the higher one.

 An in-process `NSLock` still serialises read-modify-write within a
 single process, because two threads can otherwise interleave between
 the read and the rename.
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
    public func load(domain: String) -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return readUnsafe(domain: domain)
    }

    /// Persists `cursor` for `domain`, but only if it is greater than
    /// the currently-persisted value — the cursor must never regress.
    ///
    /// Cross-process atomicity comes from `Data.write(.atomic)` which
    /// writes to a sibling temp file then `rename(2)`s over the target;
    /// POSIX `rename` is atomic on APFS. The in-process `NSLock`
    /// covers the read-modify-write window against other threads in
    /// this process (two threads can otherwise both read the old
    /// value before either writes).
    ///
    /// If two PROCESSES race, both perform the max-check, both write
    /// atomically, and the second `rename` wins. Because both did the
    /// max-check against whatever was on disk at their read time, the
    /// winning value is at least the higher of the two attempts. Worst
    /// case is a brief moment where the file holds the lower of two
    /// "newer" values; the next save heals it.
    public func save(_ cursor: Int64, domain: String) {
        lock.lock()
        defer { lock.unlock() }
        let onDisk = readUnsafe(domain: domain)
        let winner = max(onDisk, cursor)
        if winner == onDisk { return }
        writeUnsafe(winner, domain: domain)
    }

    public func reset(domain: String) {
        lock.lock()
        defer { lock.unlock() }
        let url = fileURL(for: domain)
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - Internals (must be called with `lock` held)

    private func readUnsafe(domain: String) -> Int64 {
        let url = fileURL(for: domain)
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else {
            return 0
        }
        return Int64(text.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    }

    private func writeUnsafe(_ cursor: Int64, domain: String) {
        let url = fileURL(for: domain)
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
    private func fileURL(for domain: String) -> URL {
        let safe = domain.unicodeScalars.map { scalar -> String in
            let s = String(scalar)
            if scalar.isASCII,
               let c = s.cString(using: .utf8)?.first,
               (c >= 0x30 && c <= 0x39)   // 0-9
                || (c >= 0x41 && c <= 0x5A) // A-Z
                || (c >= 0x61 && c <= 0x7A) // a-z
                || c == 0x2E || c == 0x2D || c == 0x5F { // . - _
                return s
            }
            return String(format: "%%%02X", scalar.value & 0xFF)
        }.joined()
        return directory.appendingPathComponent("\(safe).cursor")
    }
}
