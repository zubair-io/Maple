// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore.swift
import Foundation
import SQLite3
import OSLog

/// Shared metadata mirror written by the File Provider extension and read
/// by the Quick Look extension. Both run in different processes, both
/// reach the same SQLite file inside the App Group container.
///
/// The store is intentionally *not* an `actor` — the public surface is
/// blocking. Quick Look and File Provider call sites are short and the
/// SQLite calls themselves are sub-millisecond. Wrapping in an actor
/// would force callers to suspend and complicate the QL provider's
/// synchronous resolve path.
public final class FileProviderMetaStore: @unchecked Sendable {
    public struct Row: Equatable, Sendable {
        public let assetID: String
        public let conflictBasename: String?
    }

    public enum StoreError: Error, Equatable {
        case openFailed(Int32)
        case prepareFailed(String, Int32)
        case stepFailed(String, Int32)
        /// `PRAGMA journal_mode=WAL;` either returned a non-OK rc or the
        /// follow-up `PRAGMA journal_mode;` reported a mode other than
        /// "wal". WAL is load-bearing — both the FP and QL processes hold
        /// the same DB open concurrently, and without WAL a writer blocks
        /// all readers. Throw rather than continue silently.
        case walNotActive(String)
    }

    private let url: URL
    private var db: OpaquePointer?
    private let queue = DispatchQueue(label: "app.justmaple.aperture.fp-meta",
                                     qos: .userInitiated)
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider",
                             category: "meta-store")

    /// Opens (or creates) the SQLite database at `url`. The schema is
    /// migrated to `Schema.current` on open. Multiple processes can open
    /// the same file concurrently — WAL mode is enabled so readers don't
    /// block writers.
    public init(url: URL) throws {
        self.url = url
        try queue.sync {
            try openLocked()
            try migrateLocked()
        }
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    // MARK: - Public API

    public func get(domain: String, localBasename: String) throws -> Row? {
        try queue.sync {
            let sql = "SELECT asset_id, conflict_basename FROM fp_meta WHERE domain = ? AND local_basename = ?;"
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                throw StoreError.prepareFailed(sql, sqlite3_errcode(db))
            }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, domain, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(stmt, 2, localBasename, -1, SQLITE_TRANSIENT)
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { return nil }
            guard rc == SQLITE_ROW else {
                throw StoreError.stepFailed(sql, rc)
            }
            let assetID = String(cString: sqlite3_column_text(stmt, 0))
            let conflict: String? = sqlite3_column_type(stmt, 1) == SQLITE_NULL
                ? nil
                : String(cString: sqlite3_column_text(stmt, 1))
            return Row(assetID: assetID, conflictBasename: conflict)
        }
    }

    public func put(domain: String, localBasename: String,
                    assetID: String, conflictBasename: String?) throws {
        try queue.sync {
            let sql = """
            INSERT INTO fp_meta (domain, local_basename, asset_id, conflict_basename, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(domain, local_basename) DO UPDATE SET
                asset_id = excluded.asset_id,
                conflict_basename = excluded.conflict_basename,
                updated_at = excluded.updated_at;
            """
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                throw StoreError.prepareFailed(sql, sqlite3_errcode(db))
            }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, domain, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(stmt, 2, localBasename, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(stmt, 3, assetID, -1, SQLITE_TRANSIENT)
            if let conflictBasename {
                sqlite3_bind_text(stmt, 4, conflictBasename, -1, SQLITE_TRANSIENT)
            } else {
                sqlite3_bind_null(stmt, 4)
            }
            sqlite3_bind_int64(stmt, 5, Int64(Date().timeIntervalSince1970))
            let rc = sqlite3_step(stmt)
            guard rc == SQLITE_DONE else {
                throw StoreError.stepFailed(sql, rc)
            }
        }
    }

    public func remove(domain: String, localBasename: String) throws {
        try queue.sync {
            let sql = "DELETE FROM fp_meta WHERE domain = ? AND local_basename = ?;"
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                throw StoreError.prepareFailed(sql, sqlite3_errcode(db))
            }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_text(stmt, 1, domain, -1, SQLITE_TRANSIENT)
            sqlite3_bind_text(stmt, 2, localBasename, -1, SQLITE_TRANSIENT)
            let rc = sqlite3_step(stmt)
            guard rc == SQLITE_DONE else {
                throw StoreError.stepFailed(sql, rc)
            }
        }
    }

    // MARK: - Setup (queue-private)

    private func openLocked() throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let rc = sqlite3_open_v2(url.path, &db, flags, nil)
        guard rc == SQLITE_OK else {
            log.error("sqlite3_open_v2 failed rc=\(rc)")
            throw StoreError.openFailed(rc)
        }
        // Set WAL, then verify by reading back. `PRAGMA journal_mode=WAL;`
        // can silently fall back to the previous mode (delete, memory,
        // etc.) on filesystems that don't support shared-memory
        // mapping — and WAL is the only thing letting the QL extension
        // read while the FP extension is writing. Treat a mismatch as
        // fatal: the QL fallback is degraded but still correct, but
        // silent loss of WAL with no signal is exactly the bug class
        // we're guarding against.
        let walSetRc = sqlite3_exec(db, "PRAGMA journal_mode=WAL;", nil, nil, nil)
        if walSetRc != SQLITE_OK {
            log.error("PRAGMA journal_mode=WAL exec failed rc=\(walSetRc)")
            throw StoreError.walNotActive("exec rc=\(walSetRc)")
        }
        try verifyWALActiveLocked()
        let syncRc = sqlite3_exec(db, "PRAGMA synchronous=NORMAL;", nil, nil, nil)
        if syncRc != SQLITE_OK {
            log.error("PRAGMA synchronous=NORMAL failed rc=\(syncRc)")
            throw StoreError.stepFailed("PRAGMA synchronous=NORMAL", syncRc)
        }
        let busyRc = sqlite3_exec(db, "PRAGMA busy_timeout=2000;", nil, nil, nil)
        if busyRc != SQLITE_OK {
            log.error("PRAGMA busy_timeout=2000 failed rc=\(busyRc)")
            throw StoreError.stepFailed("PRAGMA busy_timeout=2000", busyRc)
        }
    }

    /// Reads `PRAGMA journal_mode;` back and asserts the value is
    /// "wal" (case-insensitive). Throws `walNotActive` otherwise.
    private func verifyWALActiveLocked() throws {
        var stmt: OpaquePointer?
        let prepareRc = sqlite3_prepare_v2(db, "PRAGMA journal_mode;", -1, &stmt, nil)
        guard prepareRc == SQLITE_OK else {
            sqlite3_finalize(stmt)
            log.error("prepare PRAGMA journal_mode failed rc=\(prepareRc)")
            throw StoreError.walNotActive("prepare rc=\(prepareRc)")
        }
        let stepRc = sqlite3_step(stmt)
        guard stepRc == SQLITE_ROW else {
            sqlite3_finalize(stmt)
            log.error("step PRAGMA journal_mode failed rc=\(stepRc)")
            throw StoreError.walNotActive("step rc=\(stepRc)")
        }
        let mode = String(cString: sqlite3_column_text(stmt, 0)).lowercased()
        sqlite3_finalize(stmt)
        guard mode == "wal" else {
            log.error("PRAGMA journal_mode reports \(mode, privacy: .public), expected wal")
            throw StoreError.walNotActive("mode=\(mode)")
        }
    }

    private func migrateLocked() throws {
        // Split prepare/step into separate guards so each surfaces the
        // correct rc. Combining them in one `guard` ran sqlite3_finalize
        // before sampling sqlite3_errcode, which can reset the error
        // code and report SQLITE_OK for a step that actually failed.
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "PRAGMA user_version;", -1, &stmt, nil) == SQLITE_OK,
              sqlite3_step(stmt) == SQLITE_ROW else {
            sqlite3_finalize(stmt)
            throw StoreError.prepareFailed("PRAGMA user_version", sqlite3_errcode(db))
        }
        let version = sqlite3_column_int(stmt, 0)
        sqlite3_finalize(stmt)
        if version < 1 {
            try execLocked(FileProviderMetaStoreSchema.createV1)
            try execLocked("PRAGMA user_version = 1;")
        }
        // Future migrations go here, gated on version < N.
    }

    private func execLocked(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(db, sql, nil, nil, &err)
        if rc != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? "(no message)"
            sqlite3_free(err)
            log.error("sqlite3_exec failed sql=\(sql, privacy: .public) rc=\(rc) msg=\(msg, privacy: .public)")
            throw StoreError.stepFailed(sql, rc)
        }
    }
}

// SQLite needs a transient binding type; the macro isn't bridged into Swift.
private let SQLITE_TRANSIENT = unsafeBitCast(
    OpaquePointer(bitPattern: -1),
    to: sqlite3_destructor_type.self
)

extension FileProviderMetaStore {
    public static let appGroupSuiteName = "group.app.justmaple.aperture"

    /// Resolves the canonical on-disk URL for the shared store. Lives at
    /// `<appGroup>/fp-meta.sqlite`. Falls back to a per-user temp path
    /// when the App Group container is unavailable (e.g. an unsigned
    /// dev build) — the FP extension will write somewhere readable but
    /// the QL extension in a different process won't see it. The
    /// resulting behaviour is graceful degradation: QL misses, OS
    /// materializes the RAW the old way.
    public static func sharedStoreURL(
        groupContainerProvider: (String) -> URL? =
            { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }
    ) -> URL {
        if let container = groupContainerProvider(appGroupSuiteName) {
            return container.appendingPathComponent("fp-meta.sqlite")
        }
        // Same basename as the App Group path so callers see a consistent
        // file. The dirname differs (temp vs container) so the QL extension
        // in a different process simply won't see writes — degraded mode.
        return FileManager.default.temporaryDirectory
            .appendingPathComponent("fp-meta.sqlite")
    }

    /// Convenience initializer that opens the canonical shared store.
    public convenience init() throws {
        try self.init(url: Self.sharedStoreURL())
    }
}
