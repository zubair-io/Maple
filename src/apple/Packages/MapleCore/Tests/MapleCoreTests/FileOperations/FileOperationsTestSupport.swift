// FileOperationsTestSupport.swift — shared real-filesystem helpers for the
// file-operations test suite (issue #2631). Every test in this directory
// works against real temp directories and real files on disk — no mocks —
// per CLAUDE.md's sidecar-layer rule, which this module's relocate/trash
// primitives fall squarely under (they move the very `.xmp` files that rule
// protects).

import Foundation
@testable import MapleCore

enum FileOperationsTestSupport {
    /// A fresh, uniquely-named temp directory. Callers `defer { cleanup(dir) }`.
    static func makeTempDir() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-file-ops-tests-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func cleanup(_ dir: URL) {
        try? FileManager.default.removeItem(at: dir)
    }

    /// Write `contents` at `url`, creating intermediate directories.
    @discardableResult
    static func write(_ contents: String, to url: URL) -> URL {
        try! FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    static func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    static func contents(_ url: URL) -> String? {
        try? String(contentsOf: url, encoding: .utf8)
    }
}
