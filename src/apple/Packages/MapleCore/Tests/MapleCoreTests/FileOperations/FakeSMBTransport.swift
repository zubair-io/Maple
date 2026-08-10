// FakeSMBTransport.swift — in-memory `SMBFileTransport` for testing
// `SMBFileOperations` (issue #2631). There is no SMB server available in
// this environment (`SMBSource.swift`'s own network calls have zero
// integration tests today for the same reason) — this substitutes for the
// wire protocol only, so tests exercise the REAL relocate / collision /
// sidecar-follow orchestration in `SMBFileOperations`, not a stand-in for
// the sidecar layer itself (that rule is about XMP read/write, which this
// isn't).

import Foundation
@testable import MapleCore

actor FakeSMBTransport: SMBFileTransport {
    private struct Entry {
        var data: Data
        var mtime: Date
    }

    private var files: [String: Entry] = [:]
    private var directories: Set<String> = ["/"]

    /// Fault injection for the crash-safety test: when set, `copyItem`
    /// throws instead of succeeding the next time `toPath` matches. This is
    /// a seam on the FAKE transport only — production `SMBFileOperations`
    /// has no knowledge of it — used to simulate "the copy step itself
    /// failed" (a dropped connection, a full disk) the same way the local
    /// engine's tests simulate it with a real unwritable destination.
    private(set) var failCopyToPath: String?

    func setFailCopyToPath(_ path: String?) {
        failCopyToPath = path
    }

    /// Seed a file directly (bypassing `copyItem`) — the SMB equivalent of
    /// `FileOperationsTestSupport.write(_:to:)`.
    func seed(_ contents: String, at path: String, mtime: Date = Date()) {
        files[path] = Entry(data: Data(contents.utf8), mtime: mtime)
        registerDirectory((path as NSString).deletingLastPathComponent)
    }

    /// Registers `dir` AND every ancestor up to `/` — a real filesystem (or
    /// SMB share) never has a deep directory without every directory above
    /// it also existing, so a single-level `directories.insert` after
    /// seeding/copying/moving a nested path would leave intermediate
    /// ancestors (e.g. `/2024` when only `/2024/Paris/IMG_1.dng` was seeded)
    /// missing and wrongly reported as `notFound`.
    private func registerDirectory(_ dir: String) {
        var current = dir.isEmpty ? "/" : dir
        while true {
            let (inserted, _) = directories.insert(current)
            if current == "/" || !inserted { break }
            let parent = (current as NSString).deletingLastPathComponent
            current = parent.isEmpty ? "/" : parent
        }
    }

    func fileContents(at path: String) -> String? {
        files[path].map { String(decoding: $0.data, as: UTF8.self) }
    }

    func fileExists(at path: String) -> Bool { files[path] != nil }
    func directoryExists(at path: String) -> Bool { directories.contains(path) }

    // MARK: - SMBFileTransport

    func attributesOfItem(atPath path: String) async throws -> [URLResourceKey: any Sendable] {
        if let entry = files[path] {
            return [.fileSizeKey: NSNumber(value: entry.data.count), .contentModificationDateKey: entry.mtime]
        }
        if directories.contains(path) {
            return [.isDirectoryKey: true]
        }
        throw FakeSMBTransportError.notFound(path)
    }

    /// Includes directory entries (with `.isDirectoryKey: true`) alongside
    /// files — needed so `SMBFileOperations`'s trash-marker scheme (an
    /// empty directory sibling, see `TrashMarker.swift`) is actually
    /// listable in tests the same way a real recursive AMSMB2 walk returns
    /// them (`SMBSource.listRAWFiles`'s doc comment: "Directories ... are
    /// skipped" — implying production callers see and filter them, which
    /// this fake previously didn't reproduce).
    func contentsOfDirectory(atPath path: String, recursive: Bool) async throws -> [[URLResourceKey: Any]] {
        let prefix = path.hasSuffix("/") ? path : path + "/"
        let fileEntries: [[URLResourceKey: Any]] = files.keys.filter { $0.hasPrefix(prefix) }.map {
            [.nameKey: ($0 as NSString).lastPathComponent, .pathKey: $0, .isDirectoryKey: false]
        }
        let dirEntries: [[URLResourceKey: Any]] = directories.filter { $0 != path && $0.hasPrefix(prefix) }.map {
            [.nameKey: ($0 as NSString).lastPathComponent, .pathKey: $0, .isDirectoryKey: true]
        }
        return fileEntries + dirEntries
    }

    func copyItem(atPath path: String, toPath: String, recursive: Bool,
                 progress: (@Sendable (Int64, Int64) -> Bool)?) async throws {
        if failCopyToPath == toPath {
            failCopyToPath = nil  // one-shot — the retry after a caller's rollback should succeed
            throw FakeSMBTransportError.injectedFailure(toPath)
        }
        guard let source = files[path] else { throw FakeSMBTransportError.notFound(path) }
        files[toPath] = source
        registerDirectory((toPath as NSString).deletingLastPathComponent)
    }

    func removeItem(atPath path: String) async throws {
        if files.removeValue(forKey: path) != nil { return }
        if directories.contains(path) {
            let prefix = path + "/"
            let doomed = files.keys.filter { $0.hasPrefix(prefix) }
            for key in doomed { files.removeValue(forKey: key) }
            directories = directories.filter { $0 != path && !$0.hasPrefix(prefix) }
            return
        }
        throw FakeSMBTransportError.notFound(path)
    }

    func createDirectory(atPath path: String) async throws {
        registerDirectory(path)
    }

    func moveItem(atPath path: String, toPath: String) async throws {
        if let entry = files.removeValue(forKey: path) {
            files[toPath] = entry
            registerDirectory((toPath as NSString).deletingLastPathComponent)
            return
        }
        guard directories.contains(path) else { throw FakeSMBTransportError.notFound(path) }
        let prefix = path + "/"
        let moved = files.filter { $0.key.hasPrefix(prefix) }
        for (key, entry) in moved {
            files.removeValue(forKey: key)
            files[toPath + key.dropFirst(path.count)] = entry
        }
        directories.remove(path)
        registerDirectory(toPath)
    }

    func setAttributes(attributes: [URLResourceKey: Any], ofItemAtPath path: String) async throws {
        guard var entry = files[path] else { throw FakeSMBTransportError.notFound(path) }
        if let mtime = attributes[.contentModificationDateKey] as? Date {
            entry.mtime = mtime
            files[path] = entry
        }
    }

    func readFile(atPath path: String) async throws -> Data {
        guard let entry = files[path] else { throw FakeSMBTransportError.notFound(path) }
        return entry.data
    }

    func writeFile(data: Data, toPath path: String) async throws {
        files[path] = Entry(data: data, mtime: Date())
        registerDirectory((path as NSString).deletingLastPathComponent)
    }
}

enum FakeSMBTransportError: Error {
    case notFound(String)
    case injectedFailure(String)
}
