// CollisionResolver.swift — shared "find a free destination name" algorithm
// for the relocate primitive (issue #2631). One implementation for both
// `LocalFileOperations` (sync `FileManager` existence checks) and
// `SMBFileOperations` (async network `stat` checks) — the `exists` closure
// is the only thing that differs, so the suffixing logic itself can't drift
// between the two engines.
//
// Mirrors the API's `pickFreePath` (`src/api/src/fs/trash.ts`): append
// `.N` before the extension until a free candidate is found. Bounded to the
// same 1000 attempts, and throws rather than silently handing back an
// occupied path — a caller that then wrote to it would clobber existing
// data.

import Foundation

public enum CollisionResolver {
    /// Maximum `.N` suffixes to try before giving up. Matches
    /// `pickFreePath`'s bound — a bare limit rather than an infinite loop
    /// protects against a caller accidentally handing this a directory that
    /// already contains 1000 numbered siblings.
    public static let maxAttempts = 1000

    /// Returns `path` unchanged if it's free. Otherwise appends `.1`, `.2`,
    /// … before the extension until a free candidate is found.
    ///
    /// `exists` is `async throws` so the SAME algorithm serves a synchronous
    /// local check (wrapped trivially) and a real network round-trip (SMB
    /// `attributesOfItem`) without duplicating the suffix math.
    ///
    /// Extensionless-input edge case: mirrors `pickFreePath`'s guard — an
    /// extensionless path gets a bare `.N` suffix appended rather than
    /// losing its basename to a naive `"\(stem).\(ext)"` join with an empty
    /// `ext`.
    public static func pickFreePath(
        _ path: String,
        exists: (String) async throws -> Bool
    ) async throws -> String {
        guard try await exists(path) else { return path }

        let ns = path as NSString
        let ext = ns.pathExtension
        let stem = ext.isEmpty ? path : String(path.dropLast(ext.count + 1))

        for n in 1...maxAttempts {
            let candidate = ext.isEmpty ? "\(stem).\(n)" : "\(stem).\(n).\(ext)"
            if try await !exists(candidate) {
                return candidate
            }
        }
        throw FileOperationError.underlying(
            "pickFreePath: exceeded \(maxAttempts) candidate paths for \(path)"
        )
    }
}
