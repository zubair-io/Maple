// PanoOutputDestination.swift — a panorama's output name, held before the
// stitch starts.
//
// The core finishes a panorama by renaming `<name>.partial` over the
// destination, so a destination that already holds a file would be
// replaced. Each stitch therefore claims a name that no file, no unfinished
// `.partial` and no other stitch in flight holds. Nothing is written until
// the core's own rename, so an interrupted stitch leaves no empty image in
// the user's library folder.

import Foundation
import os

enum PanoOutputDestination {
    enum ReserveError: Error {
        case notWritable(URL)
        case noFreeName(URL)
    }

    private static let claimed = OSAllocatedUnfairLock<Set<String>>(initialState: [])

    /// Claims `panorama-<seconds>.png` in `directory`, or the first free
    /// `panorama-<seconds>-<n>.png` when a file or another stitch holds it.
    /// Hand the name back with `release` once the stitch is over.
    static func reserve(in directory: URL, now: Date = Date()) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard FileManager.default.isWritableFile(atPath: directory.path) else {
            throw ReserveError.notWritable(directory)
        }
        let stem = "panorama-\(Int(now.timeIntervalSince1970))"
        let candidates = (1...999).lazy.map { attempt in
            directory.appendingPathComponent(attempt == 1 ? "\(stem).png" : "\(stem)-\(attempt).png")
        }
        guard let free = candidates.first(where: { isAbsentOnDisk($0) && claim($0) }) else {
            throw ReserveError.noFreeName(directory)
        }
        return free
    }

    static func release(_ url: URL) {
        _ = claimed.withLock { $0.remove(url.path) }
    }

    // Disk checks stay outside the lock: on a network folder each one can
    // block, and the lock also guards `release` and every other stitch.
    private static func isAbsentOnDisk(_ url: URL) -> Bool {
        let partial = url.deletingLastPathComponent().appendingPathComponent(url.lastPathComponent + ".partial")
        return !FileManager.default.fileExists(atPath: url.path)
            && !FileManager.default.fileExists(atPath: partial.path)
    }

    private static func claim(_ url: URL) -> Bool {
        claimed.withLock { $0.insert(url.path).inserted }
    }
}
