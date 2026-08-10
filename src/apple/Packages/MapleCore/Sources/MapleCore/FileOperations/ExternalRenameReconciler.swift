// ExternalRenameReconciler.swift — same-folder external-rename
// reconciliation (issue #2656). Orchestrates the pure `ExternalRenameMatcher`
// against real folder state: diffs the current directory listing against
// the `LibraryIndex` cache's last-known inventory, fingerprints both sides,
// and applies any confirmed matches via `LocalFileOperations.
// applyExternalRename`.
//
// Called from `FilesystemSource._index()` on EVERY successful scan — which
// covers both acceptance paths from a single call site: a scan triggered by
// `open()`/`restore()` on next launch (Maple was CLOSED for the rename), and
// a scan triggered by `FolderChangeWatcher`'s debounced callback while the
// folder is open (Maple was OPEN for the rename).
//
// Same-folder only, matching the server-side design (#2655): every
// candidate this module considers comes from ONE `currentFiles` listing —
// cross-folder external moves are a documented v1 limitation, not something
// this reconciles.

import Foundation
import OSLog

private let reconcilerLog = Logger(subsystem: "app.justmaple.aperture", category: "ExternalRenameReconciler")

public enum ExternalRenameReconciler {

    /// Diff `currentFiles` against `folderURL`'s `LibraryIndex`, reconcile
    /// any confirmed same-folder renames, and refresh the index's cached
    /// fingerprints for the files present now — so a LATER scan (after one
    /// of today's files has itself vanished) has something to match
    /// against. Returns the matches that were actually applied, for
    /// callers that want to log or surface them; empty when nothing
    /// reconciled (including the common case of no candidates at all).
    @discardableResult
    public static func reconcile(
        folderURL: URL,
        currentFiles: [URL],
        fingerprintProvider: @escaping @Sendable (URL) -> ExternalRenameFingerprint? = ExternalRenameFingerprint.live
    ) async -> [ExternalRenameMatcher.Match] {
        let store = LibraryIndexStore(folderURL: folderURL)
        let previousEntries = (try? await store.load())?.entries ?? [:]
        let applied = await applyReconciliation(
            folderURL: folderURL, currentFiles: currentFiles,
            previousEntries: previousEntries, fingerprintProvider: fingerprintProvider)

        // Refresh fingerprints for every file present now, so a future scan
        // (once one of TODAY's files has itself vanished) has cached data to
        // match against. A fresh store instance — `applyReconciliation` may
        // have written through `LocalFileOperations.applyExternalRename`'s
        // OWN store instance for the same file, and `store`'s in-memory copy
        // (loaded above) would otherwise be stale relative to that write.
        await syncFingerprintCache(
            folderURL: folderURL, currentFiles: currentFiles, fingerprintProvider: fingerprintProvider)

        return applied
    }

    // MARK: - Reconciliation

    private static func applyReconciliation(
        folderURL: URL, currentFiles: [URL],
        previousEntries: [String: LibraryIndex.LibraryEntry],
        fingerprintProvider: @Sendable (URL) -> ExternalRenameFingerprint?
    ) async -> [ExternalRenameMatcher.Match] {
        guard !previousEntries.isEmpty else { return [] }
        let currentNames = Set(currentFiles.map { $0.lastPathComponent })
        let missingNames = Set(previousEntries.keys).subtracting(currentNames)
        guard !missingNames.isEmpty else { return [] }
        let newFiles = currentFiles.filter { !previousEntries.keys.contains($0.lastPathComponent) }
        guard !newFiles.isEmpty else { return [] }

        let missingCandidates: [ExternalRenameMatcher.Candidate] = missingNames.compactMap { name in
            guard let entry = previousEntries[name],
                  let size = entry.size,
                  let dateTimeOriginal = entry.dateTimeOriginal
            else { return nil }
            return ExternalRenameMatcher.Candidate(
                path: folderURL.appendingPathComponent(name).path,
                fingerprint: ExternalRenameFingerprint(
                    size: size, dateTimeOriginal: dateTimeOriginal, cameraSerial: entry.cameraSerial))
        }
        let newCandidates: [ExternalRenameMatcher.Candidate] = newFiles.compactMap { url in
            guard let fingerprint = fingerprintProvider(url) else { return nil }
            return ExternalRenameMatcher.Candidate(path: url.path, fingerprint: fingerprint)
        }
        guard !missingCandidates.isEmpty, !newCandidates.isEmpty else { return [] }

        let matches = ExternalRenameMatcher.match(missing: missingCandidates, new: newCandidates)
        if matches.isEmpty {
            reconcilerLog.notice(
                "reconcile: \(missingCandidates.count) missing / \(newCandidates.count) new candidate(s) in \(folderURL.path, privacy: .public), no exactly-one fingerprint match — declining")
        }

        var applied: [ExternalRenameMatcher.Match] = []
        for match in matches {
            if await LocalFileOperations.applyExternalRename(oldPrimaryPath: match.oldPath, newPrimaryPath: match.newPath) {
                applied.append(match)
            }
        }
        return applied
    }

    // MARK: - Fingerprint cache refresh

    /// Skips the (EXIF-reading) provider call entirely when a file's size
    /// and mtime match what's already cached AND a `dateTimeOriginal` is
    /// already on file — mirrors `MapleIdCacheStore.lookup`'s
    /// size/mtime-gated skip so a folder with hundreds of RAWs doesn't pay
    /// an `ImageIO` metadata read for every file on every single scan.
    private static func syncFingerprintCache(
        folderURL: URL, currentFiles: [URL],
        fingerprintProvider: @Sendable (URL) -> ExternalRenameFingerprint?
    ) async {
        let store = LibraryIndexStore(folderURL: folderURL)
        let existingEntries = (try? await store.load())?.entries ?? [:]
        let fm = FileManager.default

        for url in currentFiles {
            let name = url.lastPathComponent
            guard let attrs = try? fm.attributesOfItem(atPath: url.path),
                  let size = (attrs[.size] as? NSNumber)?.int64Value
            else { continue }
            let mtime = attrs[.modificationDate] as? Date

            if let existing = existingEntries[name],
               existing.size == size, existing.mtime == mtime, existing.dateTimeOriginal != nil {
                continue
            }
            guard let fingerprint = fingerprintProvider(url) else { continue }
            try? await store.updateFingerprint(
                name: name, size: fingerprint.size, mtime: mtime,
                dateTimeOriginal: fingerprint.dateTimeOriginal, cameraSerial: fingerprint.cameraSerial)
        }
    }
}
