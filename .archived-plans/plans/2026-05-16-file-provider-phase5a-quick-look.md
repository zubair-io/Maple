# Maple File Provider — Phase 5a (Quick Look Generator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `MapleQuickLook.appex` extension that serves the pre-baked JPEG preview at `GET /api/assets/<id>/thumb` when the user hits spacebar in Finder on a Maple-mounted RAW, instead of materializing the full 40–150 MB RAW file.

**Architecture:** A new Swift app extension target (principal class `QLPreviewProvider`-conforming `MaplePreviewProvider`) registered for the RAW UTIs the File Provider exposes. The provider receives a `QLFilePreviewRequest` carrying a local file URL into the File Provider's per-domain cache. It resolves the FP domain from the URL path via `QuickLookResolver.resolveDomain`, then resolves the materialized basename back to an `assetID` by reading the shared SQLite meta store (`FileProviderMetaStore`) inside the App Group container — a single `SELECT asset_id, conflict_basename FROM fp_meta WHERE domain = ? AND local_basename = ?` query. The provider then issues an authenticated `GET /api/assets/<id>/thumb` using `RemoteCatalog.getThumb` (new) and returns a `QLPreviewReply(dataOfContentType: .jpeg, ...)`. Falls back to letting the OS materialize the RAW if the meta-store row or the thumb is missing.

**Identifier resolution decision:** the spec's first sketch puts a `<local>.maple-meta.json` sibling next to each cached file. That's fragile — the FP local cache directory can evict files independently of siblings. This plan uses a **shared SQLite mirror inside the App Group container** at `group.app.justmaple.aperture/fp-meta.sqlite` instead. Keys: `(domain, local_basename)`; values: `(asset_id, server_url, conflict_basename)`. Written when `fetchContents` succeeds; read by the QL extension. The xattr alternative is rejected (the spec calls it out as unreliable inside the FP sandbox). The sidecar-JSON alternative is rejected because the QL extension is invoked even when the file is materialized — the sidecar may not be present in some race orderings.

**Tech Stack:** Swift 5.10, QuickLookUI / QuickLook frameworks (macOS 14+), `NSFileProviderReplicatedExtension` (existing), App Groups, Keychain access groups, existing `MapleCore` SPM module. SQLite via the system `SQLite3.framework` (no third-party dependency).

## Out of scope (Phase 5b / 5c)

- iOS Quick Look extension. The Phase 4 iOS work isn't on `main`; this plan targets macOS only.
- Server-side changes. `/api/assets/:id/thumb` is consumed as-is; Phase 5c will add `If-None-Match` to it. This plan must not break when 5c lands.
- Generating thumbnails on the client when the server has none. The fallback is "let the OS materialize the RAW and decode it the slow way."
- Pre-warming the thumb cache (Phase 6+ prefetch).
- Animated preview / scrubbing / video. Maple is a stills editor.

---

## File structure

**New (extension target):**
- `src/apple/MapleQuickLook/Info.plist` — extension declaration (`NSExtension`, `QLSupportedContentTypes`)
- `src/apple/MapleQuickLook/MapleQuickLook.entitlements` — App Group + Keychain access group + network client
- `src/apple/MapleQuickLook/MaplePreviewProvider.swift` — `QLPreviewProvider` subclass implementing `QLPreviewingController`

**New (shared in MapleCore):**
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore.swift` — SQLite-backed shared mirror of `(domain, local_basename) -> (assetID, conflictBasename)`
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore+Schema.swift` — schema migration + `CREATE TABLE` constants

**Modified:**
- `src/apple/MapleFileProvider/FileProviderExtension.swift` — after a successful `fetchContents`, write a row into `FileProviderMetaStore` keyed by the chosen local URL basename
- `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift` — add `getThumb(assetID:) async throws -> Data`
- `src/apple/Maple.xcodeproj/project.pbxproj` — add the `MapleQuickLook` target, embed it in the host app

**Tests:**
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderMetaStoreTests.swift` — round-trip a row, eviction on `remove`, schema-migration idempotence
- `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogThumbTests.swift` — `URLProtocol`-mocked `getThumb` happy path, 404 path, auth-refresh path
- No UITest. Quick Look's panel isn't accessible via `XCTest`; integration coverage is the manual test in the spec.

---

## Why a SQLite mirror beats the sibling-JSON / xattr approaches

1. **Survives FP cache eviction.** The system can evict the cached payload while leaving the SQLite row intact (and vice versa — a stale row is cheap; we re-query the server on a miss). A sibling JSON gets evicted with the file.
2. **Cross-process safe.** The FP extension writes; the QL extension reads. They run in different processes. SQLite's WAL mode handles concurrent readers; we accept the (very small) write contention because writes are infrequent (one per `fetchContents`).
3. **Cheap.** ~64 bytes per row, indexed by `(domain, local_basename)`. A heavy user with 100k cached files is < 10 MB.
4. **Bounded growth.** A periodic compaction task (`VACUUM` on app launch, deleting rows older than the FP cache's retention) is straightforward. Out of scope for 5a — 100k rows isn't a problem until 5b's working set lands.

We do **not** use `GRDB` or another Swift SQLite wrapper. The schema is one table and three statements; the C API is small enough.

---

## Task 1: `FileProviderMetaStore` — schema and connection

**Files:**
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore.swift`
- Create: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore+Schema.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderMetaStoreTests.swift`

### Step 1: Write the failing test

- [ ] **Step 1: Write `FileProviderMetaStoreTests.swift`**

```swift
import XCTest
@testable import MapleCore

final class FileProviderMetaStoreTests: XCTestCase {
    private func freshStoreURL() -> URL {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("fp-meta-\(UUID().uuidString).sqlite")
        try? FileManager.default.removeItem(at: tmp)
        return tmp
    }

    func testRoundTripCanonicalRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "default", localBasename: "ABC123",
                       assetID: "650a1b2c3d4e5f6071829304",
                       conflictBasename: nil)
        let row = try store.get(domain: "default", localBasename: "ABC123")
        XCTAssertEqual(row?.assetID, "650a1b2c3d4e5f6071829304")
        XCTAssertNil(row?.conflictBasename)
    }

    func testRoundTripConflictRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "default", localBasename: "XYZ",
                       assetID: "650a", conflictBasename: "shot (conflict from MBP)")
        let row = try store.get(domain: "default", localBasename: "XYZ")
        XCTAssertEqual(row?.conflictBasename, "shot (conflict from MBP)")
    }

    func testGetMissingReturnsNil() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        XCTAssertNil(try store.get(domain: "default", localBasename: "nope"))
    }

    func testPutReplacesExistingRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "d", localBasename: "k", assetID: "old", conflictBasename: nil)
        try store.put(domain: "d", localBasename: "k", assetID: "new", conflictBasename: nil)
        XCTAssertEqual(try store.get(domain: "d", localBasename: "k")?.assetID, "new")
    }

    func testRemoveDeletesRow() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        let store = try FileProviderMetaStore(url: url)
        try store.put(domain: "d", localBasename: "k", assetID: "v", conflictBasename: nil)
        try store.remove(domain: "d", localBasename: "k")
        XCTAssertNil(try store.get(domain: "d", localBasename: "k"))
    }

    func testReopenSeesPersistedRows() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let s = try FileProviderMetaStore(url: url)
            try s.put(domain: "d", localBasename: "k", assetID: "v", conflictBasename: nil)
        }
        let s2 = try FileProviderMetaStore(url: url)
        XCTAssertEqual(try s2.get(domain: "d", localBasename: "k")?.assetID, "v")
    }

    func testSchemaMigrationIsIdempotent() throws {
        let url = freshStoreURL()
        defer { try? FileManager.default.removeItem(at: url) }
        _ = try FileProviderMetaStore(url: url)
        _ = try FileProviderMetaStore(url: url)
        _ = try FileProviderMetaStore(url: url)
        // No throw = pass
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/apple/Packages/MapleCore
swift test --filter FileProviderMetaStoreTests
```

Expected: compile error — `FileProviderMetaStore` not defined.

### Step 3: Implement the schema constants

- [ ] **Step 3: Write `FileProviderMetaStore+Schema.swift`**

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore+Schema.swift
import Foundation

enum FileProviderMetaStoreSchema {
    /// Bump when the table layout changes; the store reads
    /// `PRAGMA user_version` and runs migrations to reach `current`.
    static let current: Int32 = 1

    static let createV1 = """
    CREATE TABLE IF NOT EXISTS fp_meta (
        domain          TEXT NOT NULL,
        local_basename  TEXT NOT NULL,
        asset_id        TEXT NOT NULL,
        conflict_basename TEXT,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (domain, local_basename)
    );
    """
}
```

### Step 4: Implement the store

- [ ] **Step 4: Write `FileProviderMetaStore.swift`**

```swift
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
        sqlite3_exec(db, "PRAGMA journal_mode=WAL;", nil, nil, nil)
        sqlite3_exec(db, "PRAGMA synchronous=NORMAL;", nil, nil, nil)
        sqlite3_exec(db, "PRAGMA busy_timeout=2000;", nil, nil, nil)
    }

    private func migrateLocked() throws {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, "PRAGMA user_version;", -1, &stmt, nil) == SQLITE_OK,
              sqlite3_step(stmt) == SQLITE_ROW else {
            throw StoreError.prepareFailed("PRAGMA user_version", sqlite3_errcode(db))
        }
        let version = sqlite3_column_int(stmt, 0)
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd src/apple/Packages/MapleCore
swift test --filter FileProviderMetaStoreTests
```

Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore.swift \
        src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore+Schema.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderMetaStoreTests.swift
git commit -m "feat(fileprovider): add FileProviderMetaStore shared SQLite mirror"
```

---

## Task 2: `FileProviderMetaStore.shared(...)` — App Group resolver

The store works against any URL in tests; production code needs a single canonical path inside the App Group container.

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore.swift`
- Modify: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderMetaStoreTests.swift`

- [ ] **Step 1: Write a failing test for the resolver**

Append to `FileProviderMetaStoreTests.swift`:

```swift
func testSharedURLLivesUnderAppGroupContainer() throws {
    // The function is purely a path resolver — it should not require
    // the App Group to actually exist on the test host. We assert the
    // computed URL ends with the expected filename and falls back to
    // the temp dir when the App Group container is unavailable.
    let url = FileProviderMetaStore.sharedStoreURL(
        groupContainerProvider: { _ in nil }
    )
    XCTAssertEqual(url.lastPathComponent, "fp-meta.sqlite")
}

func testSharedURLPrefersAppGroupContainer() throws {
    let stub = FileManager.default.temporaryDirectory
        .appendingPathComponent("group-stub-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: stub, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: stub) }
    let url = FileProviderMetaStore.sharedStoreURL(
        groupContainerProvider: { _ in stub }
    )
    XCTAssertTrue(url.path.hasPrefix(stub.path),
                  "expected \(url.path) to start with \(stub.path)")
    XCTAssertEqual(url.lastPathComponent, "fp-meta.sqlite")
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/apple/Packages/MapleCore && swift test --filter FileProviderMetaStoreTests/testSharedURLLivesUnderAppGroupContainer
```

Expected: compile error — `sharedStoreURL` not defined.

- [ ] **Step 3: Implement the resolver**

Add to `FileProviderMetaStore.swift`:

```swift
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
        return FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-fp-meta.sqlite")
    }

    /// Convenience initializer that opens the canonical shared store.
    public convenience init() throws {
        try self.init(url: Self.sharedStoreURL())
    }
}
```

- [ ] **Step 4: Run all `FileProviderMetaStoreTests` to confirm green**

```bash
cd src/apple/Packages/MapleCore && swift test --filter FileProviderMetaStoreTests
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/FileProviderMetaStore.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileProviderMetaStoreTests.swift
git commit -m "feat(fileprovider): add FileProviderMetaStore.sharedStoreURL App Group resolver"
```

---

## Task 3: `RemoteCatalog.getThumb(assetID:)`

The QL extension needs a thin RPC for `GET /api/assets/<id>/thumb`. Mirrors `getXMP` in style — returns `Data`, throws on non-2xx.

**Files:**
- Modify: `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift`
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogThumbTests.swift`

- [ ] **Step 1: Write the failing test**

Look at the existing `RemoteCatalogTests.swift` (sibling file) to see the `URLProtocol`-mock harness already used in the package — reuse it. If unsure, search:

```bash
rg -n "URLProtocol" src/apple/Packages/MapleCore/Tests
```

Write `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogThumbTests.swift`:

```swift
import XCTest
@testable import MapleCore

final class RemoteCatalogThumbTests: XCTestCase {
    func testGetThumbHappyPath() async throws {
        let server = URL(string: "https://example.test")!
        let session = MockURLProtocol.makeSession()
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/api/assets/650a/thumb")
            return (HTTPURLResponse(url: req.url!, statusCode: 200,
                                    httpVersion: nil, headerFields: nil)!,
                    Data([0xFF, 0xD8, 0xFF, 0xE0]))
        }
        let http = AuthenticatedHTTPClient(
            server: server,
            urlSession: session,
            tokensProvider: { AuthTokens(access: "t", refresh: "r") },
            onTokensRefreshed: { _ in },
            onSignOut: { }
        )
        let catalog = RemoteCatalog(http: http, server: server)
        let bytes = try await catalog.getThumb(assetID: "650a")
        XCTAssertEqual(bytes.prefix(4), Data([0xFF, 0xD8, 0xFF, 0xE0]))
    }

    func testGetThumb404Throws() async {
        let server = URL(string: "https://example.test")!
        let session = MockURLProtocol.makeSession()
        MockURLProtocol.handler = { req in
            (HTTPURLResponse(url: req.url!, statusCode: 404,
                             httpVersion: nil, headerFields: nil)!,
             Data())
        }
        let http = AuthenticatedHTTPClient(
            server: server,
            urlSession: session,
            tokensProvider: { AuthTokens(access: "t", refresh: "r") },
            onTokensRefreshed: { _ in },
            onSignOut: { }
        )
        let catalog = RemoteCatalog(http: http, server: server)
        do {
            _ = try await catalog.getThumb(assetID: "missing")
            XCTFail("expected throw")
        } catch {
            // pass
        }
    }
}
```

If `MockURLProtocol` doesn't exist in the package's test helpers, search for it:

```bash
rg -n "class MockURLProtocol" src/apple/Packages/MapleCore
```

If it really doesn't exist (unlikely — `RemoteCatalogTests` will have one), copy the pattern from `src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogTests.swift` and reuse here.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src/apple/Packages/MapleCore && swift test --filter RemoteCatalogThumbTests
```

Expected: compile error — `getThumb` not defined.

- [ ] **Step 3: Implement `getThumb`**

Add to `RemoteCatalog.swift` next to `downloadAsset`:

```swift
/// GET /api/assets/<assetID>/thumb. Returns the JPEG bytes of the
/// pre-baked preview. Throws on non-2xx — 404 in particular means
/// "thumbnail not generated yet" and the Quick Look extension
/// uses that signal to fall back to OS-default RAW materialization.
public func getThumb(assetID: String) async throws -> Data {
    let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/thumb"))
    let (data, resp) = try await http.data(for: req)
    try Self.check2xx(resp)
    return data
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src/apple/Packages/MapleCore && swift test --filter RemoteCatalogThumbTests
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/RemoteCatalogThumbTests.swift
git commit -m "feat(fileprovider): RemoteCatalog.getThumb(assetID:)"
```

---

## Task 4: FP extension records metadata on every `fetchContents`

Every successful download of an asset or sidecar gets a row in the shared store so the Quick Look extension can later resolve the local file URL back to its asset ID.

**Files:**
- Modify: `src/apple/MapleFileProvider/FileProviderExtension.swift`

The function key is the basename of the local URL we hand back from `fetchContents` (the FP system caches that file under the OS's per-domain cache directory; we don't control the parent dir but we own the filename). Today the extension uses `UUID().uuidString` as the basename — that's stable for the lifetime of the cached file, which is all we need.

- [ ] **Step 1: Add the store as a stored property**

In `FileProviderExtension.swift`, add to the property list:

```swift
private let metaStore: FileProviderMetaStore?
```

In `init`, after the `catalog` is constructed, before `super.init()`:

```swift
// Best-effort: a store-open failure mustn't break the extension.
// Quick Look will degrade to full-RAW materialization; everything
// else keeps working.
let metaStore: FileProviderMetaStore? = {
    do { return try FileProviderMetaStore() } catch {
        configLogger.error("FileProviderMetaStore open failed: \(String(describing: error), privacy: .public)")
        return nil
    }
}()
self.metaStore = metaStore
```

…and add a matching `self.metaStore = nil` in the dormant-branch return path.

(Note: `configLogger` doesn't exist in this scope; use `Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "extension").error(...)` directly, or call `self.log` after `super.init`.)

- [ ] **Step 2: Write the row after a successful asset download**

In `fetchContents(for:version:request:completionHandler:)`, replace the asset branch:

```swift
case .asset(let id):
    try await catalog.downloadAsset(assetID: id, to: localURL)
    self.recordMeta(domain: self.domain.identifier.rawValue,
                    localBasename: localURL.lastPathComponent,
                    assetID: id,
                    conflictBasename: nil)
    completionHandler(localURL, nil, nil)
    return
```

And the sidecar branch:

```swift
case .sidecar(let assetID, let conflictBasename):
    let bytes = try await catalog.getXMP(assetID: assetID, conflictBasename: conflictBasename)
    try bytes.write(to: localURL, options: .atomic)
    self.recordMeta(domain: self.domain.identifier.rawValue,
                    localBasename: localURL.lastPathComponent,
                    assetID: assetID,
                    conflictBasename: conflictBasename)
    completionHandler(localURL, nil, nil)
    return
```

- [ ] **Step 3: Add the helper**

Add to the extension class (after the existing `signalEnumeratorReload` helper):

```swift
/// Best-effort: a write failure here only means Quick Look will fall
/// back to RAW materialization. We log and swallow.
private func recordMeta(domain: String,
                         localBasename: String,
                         assetID: String,
                         conflictBasename: String?) {
    guard let metaStore else { return }
    do {
        try metaStore.put(domain: domain,
                          localBasename: localBasename,
                          assetID: assetID,
                          conflictBasename: conflictBasename)
    } catch {
        log.error("metaStore.put failed: \(error.localizedDescription, privacy: .public)")
    }
}
```

- [ ] **Step 4: Verify the extension still builds**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' -quiet build
```

If `libraw_ffi.a` is missing inside `Frameworks/RawPipeline.xcframework`, run `./src/apple/scripts/build-xcframework.sh` first.

- [ ] **Step 5: Commit**

```bash
git add src/apple/MapleFileProvider/FileProviderExtension.swift
git commit -m "feat(fileprovider): record local-basename->assetID in shared meta store on fetch"
```

---

## Task 5: `MapleQuickLook` target — scaffold

This task adds the extension target itself (no logic yet). The next task fills in the provider.

**Files:**
- Create: `src/apple/MapleQuickLook/Info.plist`
- Create: `src/apple/MapleQuickLook/MapleQuickLook.entitlements`
- Create: `src/apple/MapleQuickLook/MaplePreviewProvider.swift` (stub)
- Modify: `src/apple/Maple.xcodeproj/project.pbxproj`

- [ ] **Step 1: Create `MapleQuickLook/Info.plist`**

Bundle ID: `app.justmaple.aperture.QuickLook`. The `QLSupportedContentTypes` list mirrors what `MapleItem.contentType` exposes for assets in the FP enumeration. Today that's RAW UTIs (DNG, NEF, CR2, CR3, ARW, etc.) plus the XMP sidecar UTI. Cover the common set; the system silently skips a preview for types we don't list, which is the same as today's behaviour.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>Maple Quick Look</string>
    <key>NSExtension</key>
    <dict>
        <key>NSExtensionAttributes</key>
        <dict>
            <key>QLSupportedContentTypes</key>
            <array>
                <string>com.adobe.raw-image</string>
                <string>public.camera-raw-image</string>
                <string>com.adobe.xmp</string>
            </array>
            <key>QLSupportsSearchableItems</key>
            <false/>
        </dict>
        <key>NSExtensionPointIdentifier</key>
        <string>com.apple.quicklook.preview</string>
        <key>NSExtensionPrincipalClass</key>
        <string>$(PRODUCT_MODULE_NAME).MaplePreviewProvider</string>
    </dict>
</dict>
</plist>
```

- [ ] **Step 2: Create `MapleQuickLook/MapleQuickLook.entitlements`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>group.app.justmaple.aperture</string>
    </array>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-only</key>
    <true/>
    <key>keychain-access-groups</key>
    <array>
        <string>$(AppIdentifierPrefix)app.justmaple.aperture.shared</string>
    </array>
</dict>
</plist>
```

- [ ] **Step 3: Create the stub provider**

`src/apple/MapleQuickLook/MaplePreviewProvider.swift`:

```swift
// src/apple/MapleQuickLook/MaplePreviewProvider.swift
import QuickLookUI
import OSLog

final class MaplePreviewProvider: QLPreviewProvider, QLPreviewingController {
    private let log = Logger(subsystem: "app.justmaple.aperture.quicklook",
                             category: "provider")

    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        log.notice("stub providePreview fileURL=\(request.fileURL.path, privacy: .public)")
        throw NSError(domain: "MapleQuickLook", code: -1,
                      userInfo: [NSLocalizedDescriptionKey: "not implemented yet"])
    }
}
```

- [ ] **Step 4: Add the target to `project.pbxproj`**

Add a new `PBXNativeTarget` `MapleQuickLook` with:
- `productType = "com.apple.product-type.app-extension"`
- Bundle ID: `app.justmaple.aperture.QuickLook`
- Frameworks phase: links `QuickLookUI.framework`, `QuickLook.framework`, and the `MapleCore` package product
- Sources phase: `MaplePreviewProvider.swift`
- Resources: handled via `INFOPLIST_FILE` build setting
- Build settings:
  - `PRODUCT_BUNDLE_IDENTIFIER = app.justmaple.aperture.QuickLook`
  - `PRODUCT_NAME = MapleQuickLook`
  - `MACOSX_DEPLOYMENT_TARGET = 14.0`
  - `CODE_SIGN_ENTITLEMENTS = MapleQuickLook/MapleQuickLook.entitlements`
  - `INFOPLIST_FILE = MapleQuickLook/Info.plist`
  - `SWIFT_VERSION = 5.0`
  - `SKIP_INSTALL = YES`
  - `DEVELOPMENT_TEAM = QREP66JW5U` (match the other targets)
- Add a `PBXCopyFilesBuildPhase` on the `Maple` target with `dstSubfolderSpec = 13` (PlugIns) that embeds `MapleQuickLook.appex`.
- Add `MapleQuickLook` to `Maple`'s `dependencies`.

If editing pbxproj by hand is brittle, follow Phase 1's escape hatch: add the target through Xcode's GUI (File → New → Target → Quick Look Preview Extension), then capture the resulting diff in one commit and reset any unwanted Xcode noise (e.g. file system synchronization groups for unrelated targets).

- [ ] **Step 5: Verify the extension builds and embeds**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' -quiet build
ls build/Release/Maple.app/Contents/PlugIns 2>/dev/null || \
  ls ~/Library/Developer/Xcode/DerivedData/Maple-*/Build/Products/Debug/Maple.app/Contents/PlugIns
```

Expected: `MapleFileProvider.appex` and `MapleQuickLook.appex` both listed.

- [ ] **Step 6: Commit**

```bash
git add src/apple/MapleQuickLook/ src/apple/Maple.xcodeproj/project.pbxproj
git commit -m "feat(apple): scaffold MapleQuickLook extension target"
```

---

## Task 6: Wire `MaplePreviewProvider` to read metadata + fetch the thumb

This is the actual feature.

**Files:**
- Modify: `src/apple/MapleQuickLook/MaplePreviewProvider.swift`

The provider must:
1. Open the shared `FileProviderMetaStore`.
2. Look up `(domain, localBasename)` to get the asset ID.
3. Load the domain's `FileProviderDomainConfig` (server URL).
4. Load tokens via `FileProviderTokensStore`.
5. Build an `AuthenticatedHTTPClient`.
6. Call `RemoteCatalog.getThumb(assetID:)`.
7. Return a `QLPreviewReply(dataOfContentType: .jpeg, ...)`.

If any step fails, throw an error — the OS falls back to system-default preview, which for a RAW means a slower full-materialization path. That's the desired degradation.

**Resolving the domain identifier from the file URL:** the cached file lives inside the per-domain temp directory the FP extension obtained via `manager?.temporaryDirectoryURL()`. The path looks like `<...>/<domain-id>/<UUID>` for our setup. In practice the FP system parents that under a directory whose name includes the domain identifier; we can extract it by walking parent directories looking for any segment that matches one of the configured domains. This is enough for the single-domain case which is what 5a ships with — multi-domain Quick Look is a 5b concern (covered there).

- [ ] **Step 1: Replace the stub with the full implementation**

```swift
// src/apple/MapleQuickLook/MaplePreviewProvider.swift
import QuickLookUI
import UniformTypeIdentifiers
import MapleCore
import OSLog

final class MaplePreviewProvider: QLPreviewProvider, QLPreviewingController {
    private let log = Logger(subsystem: "app.justmaple.aperture.quicklook",
                             category: "provider")
    private let metaStore: FileProviderMetaStore?
    private let config: FileProviderConfig

    override init() {
        self.metaStore = try? FileProviderMetaStore()
        self.config = FileProviderConfig()
        super.init()
    }

    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        let fileURL = request.fileURL
        let basename = fileURL.lastPathComponent
        log.notice("providePreview basename=\(basename, privacy: .public)")

        // 1. Resolve the domain. Walk parent path components looking
        //    for a match against any configured FP domain identifier.
        let configuredDomains = Set(config.allDomains().map { $0.domainIdentifier })
        guard let (domainID, _) = Self.resolveDomain(from: fileURL,
                                                      configured: configuredDomains) else {
            log.notice("no FP domain matches \(fileURL.path, privacy: .public) — falling back")
            throw QLPreviewError.noPreview
        }

        // 2. Look up (domain, basename) -> assetID.
        guard let store = metaStore else {
            log.notice("meta store unavailable — falling back")
            throw QLPreviewError.noPreview
        }
        guard let row = try? store.get(domain: domainID, localBasename: basename),
              let row = row else {
            log.notice("no meta row for basename=\(basename, privacy: .public) in domain \(domainID, privacy: .public) — falling back")
            throw QLPreviewError.noPreview
        }

        // 3. Sidecars don't have a useful preview — let the system show
        //    the raw text. (XMP is XML; QuickLook renders it via the
        //    default text previewer.)
        if row.conflictBasename != nil || basename.lowercased().hasSuffix(".xmp") {
            throw QLPreviewError.noPreview
        }

        // 4. Load domain config + tokens.
        guard let cfg = config.load(domain: domainID) else {
            log.notice("domain config missing for \(domainID, privacy: .public) — falling back")
            throw QLPreviewError.noPreview
        }
        let tokensStore = FileProviderTokensStore()
        let session = URLSession(configuration: .default)
        let http = AuthenticatedHTTPClient(
            server: cfg.serverURL,
            urlSession: session,
            tokensProvider: { tokensStore.load(domain: domainID) },
            onTokensRefreshed: { tokensStore.save($0, domain: domainID) },
            onSignOut: { tokensStore.remove(domain: domainID) }
        )
        let catalog = RemoteCatalog(http: http, server: cfg.serverURL)

        // 5. Fetch the JPEG.
        let bytes: Data
        do {
            bytes = try await catalog.getThumb(assetID: row.assetID)
        } catch {
            log.notice("thumb fetch failed: \(error.localizedDescription, privacy: .public) — falling back")
            throw QLPreviewError.noPreview
        }

        // 6. Build the reply. contentSize is advisory; the JPEG header
        //    carries the truth and QL re-reads it. Using a 1024-square
        //    placeholder is conventional; QL re-aspects on display.
        let reply = QLPreviewReply(
            dataOfContentType: .jpeg,
            contentSize: CGSize(width: 1024, height: 1024)
        ) { _ in bytes }
        return reply
    }

    /// Walk parent path components for a hit against the configured
    /// FP domain identifiers. The FP cache directory layout includes
    /// the domain identifier as one of the parents
    /// (`/Users/.../FileProvider/<bundle>/<domain>/...`); returns the
    /// first hit. Internal for tests.
    static func resolveDomain(from fileURL: URL,
                               configured: Set<String>) -> (domain: String, hitComponent: String)? {
        var url = fileURL.deletingLastPathComponent()
        while url.path != "/" {
            let last = url.lastPathComponent
            if configured.contains(last) {
                return (last, last)
            }
            let parent = url.deletingLastPathComponent()
            if parent.path == url.path { break }
            url = parent
        }
        // Fallback for the single-domain case: if there's exactly one
        // configured domain, use it. This is what unblocks the spec's
        // happy-path manual test on a fresh install.
        if configured.count == 1, let only = configured.first {
            return (only, only)
        }
        return nil
    }
}
```

- [ ] **Step 2: Build the project**

```bash
cd src/apple
xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' -quiet build
```

- [ ] **Step 3: Commit**

```bash
git add src/apple/MapleQuickLook/MaplePreviewProvider.swift
git commit -m "feat(quicklook): resolve assetID via meta store and serve /api/assets/:id/thumb"
```

---

## Task 7: Unit-test `MaplePreviewProvider.resolveDomain`

The provider itself is hard to unit-test (lives in an `appex`), but the pure path-resolver is plain Swift.

**Files:**
- Create: `src/apple/Packages/MapleCore/Tests/MapleCoreTests/QuickLookResolverTests.swift`
- The function being tested is `static`; to test it from `MapleCoreTests` we either (a) move it into `MapleCore` or (b) re-implement it inline in the test. Option (a) is cleaner; do that.

- [ ] **Step 1: Move the resolver into `MapleCore`**

Create `src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/QuickLookResolver.swift`:

```swift
// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/QuickLookResolver.swift
import Foundation

public enum QuickLookResolver {
    /// Walks parent components of a Quick-Look-supplied file URL looking
    /// for a directory whose name matches a configured File Provider
    /// domain identifier. Returns the first match.
    ///
    /// As a fallback, if exactly one domain is configured, returns it
    /// unconditionally — this is the common case on a fresh install
    /// and matches the spec's primary user flow.
    public static func resolveDomain(from fileURL: URL,
                                      configured: Set<String>) -> String? {
        var url = fileURL.deletingLastPathComponent()
        while url.path != "/" {
            if configured.contains(url.lastPathComponent) {
                return url.lastPathComponent
            }
            let parent = url.deletingLastPathComponent()
            if parent.path == url.path { break }
            url = parent
        }
        if configured.count == 1, let only = configured.first {
            return only
        }
        return nil
    }
}
```

- [ ] **Step 2: Update `MaplePreviewProvider` to call into `MapleCore`**

In `MaplePreviewProvider.swift`, delete the inline `resolveDomain` static and replace the call:

```swift
guard let domainID = QuickLookResolver.resolveDomain(from: fileURL,
                                                     configured: configuredDomains) else { ... }
```

- [ ] **Step 3: Write `QuickLookResolverTests.swift`**

```swift
import XCTest
@testable import MapleCore

final class QuickLookResolverTests: XCTestCase {
    func testReturnsMatchingComponent() {
        let url = URL(filePath: "/Users/x/Library/.../FileProvider/aperture/MyDomain/ABC")
        let hit = QuickLookResolver.resolveDomain(from: url,
                                                  configured: ["MyDomain", "Other"])
        XCTAssertEqual(hit, "MyDomain")
    }

    func testReturnsNilWhenNoMatchAndMultipleConfigured() {
        let url = URL(filePath: "/Users/x/tmp/ABC")
        let hit = QuickLookResolver.resolveDomain(from: url,
                                                  configured: ["A", "B"])
        XCTAssertNil(hit)
    }

    func testFallsBackToSoleConfiguredDomain() {
        let url = URL(filePath: "/Users/x/tmp/ABC")
        let hit = QuickLookResolver.resolveDomain(from: url, configured: ["Only"])
        XCTAssertEqual(hit, "Only")
    }

    func testReturnsNilWhenNoneConfigured() {
        let url = URL(filePath: "/Users/x/tmp/ABC")
        let hit = QuickLookResolver.resolveDomain(from: url, configured: [])
        XCTAssertNil(hit)
    }
}
```

- [ ] **Step 4: Run all MapleCore tests to confirm green**

```bash
cd src/apple/Packages/MapleCore && swift test
```

- [ ] **Step 5: Commit**

```bash
git add src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/QuickLookResolver.swift \
        src/apple/Packages/MapleCore/Tests/MapleCoreTests/QuickLookResolverTests.swift \
        src/apple/MapleQuickLook/MaplePreviewProvider.swift
git commit -m "feat(fileprovider): extract QuickLookResolver into MapleCore for tests"
```

---

## Task 8: End-to-end smoke (manual)

Quick Look's panel isn't reachable from `XCTest`. The CI signal is the unit tests + the build success. The integration signal is a manual run.

- [ ] **Step 1: Manual test the happy path**

1. Build and run the host app from Xcode (`Maple` scheme, My Mac).
2. In Maple's Settings, enable the File Provider domain pointing at a known server with at least one indexed RAW.
3. In Finder, navigate into the Maple-mounted library.
4. Click a RAW once to select it (do not double-click).
5. Press spacebar.
6. **Expected:** a JPEG preview appears within ~250 ms (warm) or ~500 ms (first time the asset is touched). Compare to the multi-second wait without 5a.
7. Press spacebar again to dismiss; press again to re-open.
8. **Expected:** second open is instant (system cached the reply data).

- [ ] **Step 2: Manual test the fallback path**

1. On the server, delete `<folder>/.maple/<basename>.jpg` for one RAW.
2. In Finder, spacebar that RAW.
3. **Expected:** OS falls back to the system RAW preview (slower, full materialization). No hang, no error dialog.

- [ ] **Step 3: Manual test the no-config path**

1. Disable the File Provider domain in Settings.
2. Spacebar a file from a totally unrelated location (e.g. a JPEG on the Desktop).
3. **Expected:** normal QuickLook behaviour — no impact from the new extension.

- [ ] **Step 4: Capture log output**

In Console.app, filter on subsystem `app.justmaple.aperture.quicklook`. Confirm:
- `providePreview basename=…` fires on each spacebar press.
- Fallback paths log a `falling back` notice.

If any of the manual tests fail, file follow-ups; do not amend the plan in flight.

There is no commit at this step (it's a verification step).

---

## Self-review

**Spec coverage**

- 5a goal "stop materializing 150 MB RAWs on spacebar" — implemented in Task 6 by issuing `getThumb` instead of `downloadAsset`.
- 5a architecture "new `MapleQuickLook.appex` extension" — Task 5.
- 5a identifier-resolution challenge — handled via SQLite mirror (rejected the spec's sibling-JSON sketch with rationale at the top).
- 5a auth sharing — Tasks 6 (uses existing `AuthenticatedHTTPClient`, `FileProviderTokensStore`, App Group).
- 5a server changes "none" — confirmed; no server tasks here.
- 5a fallback behaviour — handled in Task 6 (every failure throws `QLPreviewError.noPreview` so OS degrades to default).
- 5a testing strategy — Tasks 1, 3, 7 (unit), Task 8 (manual integration). The spec explicitly says no UITest.

**Placeholders**

None. Every step contains the actual code or command.

**Type consistency**

- `FileProviderMetaStore.Row`, `put(domain:localBasename:assetID:conflictBasename:)`, `get(domain:localBasename:)` — same names across Tasks 1, 2, 4, 6.
- `RemoteCatalog.getThumb(assetID:) -> Data` — same in Tasks 3, 6.
- `QuickLookResolver.resolveDomain(from:configured:) -> String?` — same in Tasks 6, 7.

**Notable risk to flag in review**

- The `QLPreviewProvider`'s `override init()` works for non-`QLPreviewProvider` extension principals but `QLPreviewProvider` is itself an `NSObject` subclass with a designated `init` — the override should compile but if the Quick Look runtime complains, fall back to the framework's `init?(coder:)` path. The first manual run will surface this immediately.
- The `QLSupportedContentTypes` list in `Info.plist` covers the common camera-RAW UTIs but may need extension for less-common formats. The spec's manual test covers a single representative RAW; broaden the list when a user hits a missed format.

---

## Done when

- [ ] All `MapleCoreTests` pass (`swift test`) including the new `FileProviderMetaStoreTests`, `RemoteCatalogThumbTests`, `QuickLookResolverTests`.
- [ ] `xcodebuild -project Maple.xcodeproj -scheme Maple -destination 'platform=macOS' build` succeeds and produces both `MapleFileProvider.appex` and `MapleQuickLook.appex`.
- [ ] Manual smoke (Task 8) shows a JPEG preview on spacebar within ~250 ms warm.
- [ ] Logs show the fall-back path engaging cleanly when the thumb endpoint 404s.
