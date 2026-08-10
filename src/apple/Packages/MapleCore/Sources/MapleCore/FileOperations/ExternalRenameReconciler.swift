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
//
// `store` is caller-owned (#2656 review): `FilesystemSource` holds ONE
// `LibraryIndexStore` for the folder it has open and passes it in here —
// every read and write this module (and the `applyExternalRename` calls it
// makes) performs for that folder goes through that SAME actor instance, so
// calls serialize through it rather than racing independent instances over
// the same `index.json` (an independent instance re-reads from disk at
// construction, so two of them used across a suspension point can each miss
// the other's write and the later `save()` silently discards it).

import Foundation
import OSLog

private let reconcilerLog = Logger(subsystem: "app.justmaple.aperture", category: "ExternalRenameReconciler")

public enum ExternalRenameReconciler {

    /// Per-scan cap on how many files `syncFingerprintCache` will read EXIF
    /// for. A first-ever scan of a large folder has nothing cached for ANY
    /// file, so without a cap every file would pay an `ImageIO` metadata
    /// read in one synchronous burst during `open()` — real cost for a scan
    /// that usually has nothing to reconcile. Capping makes warm-up
    /// incremental — later scans (the next watcher tick, the next
    /// `open()`) pick up wherever this one left off, since a file already
    /// warmed is skipped on every subsequent scan until its size/mtime
    /// changes.
    private static let maxFingerprintWarmupPerScan = 200

    /// Diff `currentFiles` against `folderURL`'s `LibraryIndex`, reconcile
    /// any confirmed same-folder renames, and refresh the index's cached
    /// fingerprints for the files present now — so a LATER scan (after one
    /// of today's files has itself vanished) has something to match
    /// against. Returns the matches that were actually applied, for
    /// callers that want to log or surface them; empty when nothing
    /// reconciled (including the common case of no candidates at all).
    @discardableResult
    public static func reconcile(
        store: LibraryIndexStore,
        folderURL: URL,
        currentFiles: [URL],
        fingerprintProvider: @escaping @Sendable (URL) -> ExternalRenameFingerprint? = ExternalRenameFingerprint.live
    ) async -> [ExternalRenameMatcher.Match] {
        let previousEntries = (try? await store.load())?.entries ?? [:]
        let applied = await applyReconciliation(
            store: store, folderURL: folderURL, currentFiles: currentFiles,
            previousEntries: previousEntries, fingerprintProvider: fingerprintProvider)

        // Refresh fingerprints for files present now, so a future scan
        // (once one of TODAY's files has itself vanished) has cached data to
        // match against. Re-reads from `store` fresh — `applyReconciliation`
        // may have written through this SAME store (removing/adding entries
        // for a reconciled match), and this pass must see that.
        await syncFingerprintCache(
            store: store, currentFiles: currentFiles, fingerprintProvider: fingerprintProvider)

        return applied
    }

    // MARK: - Reconciliation

    /// `internal`, not `private`: `ExternalRenameReconcilerTests` calls this
    /// directly to exercise the size-gate in isolation from
    /// `syncFingerprintCache`'s independent cache-warming provider calls —
    /// `reconcile(...)` runs both in the same call, so counting provider
    /// invocations at that level conflates two different reasons the
    /// provider might legitimately be called.
    static func applyReconciliation(
        store: LibraryIndexStore, folderURL: URL, currentFiles: [URL],
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
        guard !missingCandidates.isEmpty else { return [] }

        // Size-gate (#2656 review): a full fingerprint read is an `ImageIO`
        // EXIF pass, not free. Most "new" files in a scan are ordinary
        // imports, not renames — cheaply reject any new file whose SIZE
        // (already known from a plain `stat`, no decode) doesn't match ANY
        // missing candidate before paying for its EXIF read at all. A pure
        // rename never changes file bytes, so a genuine match's size is
        // always exact.
        let missingSizes = Set(missingCandidates.map { $0.fingerprint.size })
        let fm = FileManager.default
        let newCandidates: [ExternalRenameMatcher.Candidate] = newFiles.compactMap { url in
            guard let attrs = try? fm.attributesOfItem(atPath: url.path),
                  let size = (attrs[.size] as? NSNumber)?.int64Value,
                  missingSizes.contains(size)
            else { return nil }
            guard let fingerprint = fingerprintProvider(url) else { return nil }
            return ExternalRenameMatcher.Candidate(path: url.path, fingerprint: fingerprint)
        }
        guard !newCandidates.isEmpty else { return [] }

        let matches = ExternalRenameMatcher.match(missing: missingCandidates, new: newCandidates)
        if matches.isEmpty {
            reconcilerLog.notice(
                "reconcile: \(missingCandidates.count) missing / \(newCandidates.count) new candidate(s) in \(folderURL.path, privacy: .public), no exactly-one fingerprint match — declining")
        }

        var applied: [ExternalRenameMatcher.Match] = []
        for match in matches {
            if await LocalFileOperations.applyExternalRename(
                oldPrimaryPath: match.oldPath, newPrimaryPath: match.newPath, libraryIndexStore: store
            ) {
                applied.append(match)
            }
        }
        return applied
    }

    // MARK: - Fingerprint cache refresh

    /// Skips the (EXIF-reading) provider call entirely when a file's size
    /// and mtime match what's already cached AND a `dateTimeOriginal` is
    /// already on file — mirrors `MapleIdCacheStore.lookup`'s
    /// size/mtime-gated skip. Bounded to `maxFingerprintWarmupPerScan`
    /// files needing a refresh per call (see its doc comment) and writes
    /// every change collected this call in exactly ONE `store.
    /// updateFingerprints(_:)` — one atomic JSON rewrite no matter how many
    /// entries changed, instead of one rewrite per file.
    private static func syncFingerprintCache(
        store: LibraryIndexStore, currentFiles: [URL],
        fingerprintProvider: @Sendable (URL) -> ExternalRenameFingerprint?
    ) async {
        let existingEntries = (try? await store.load())?.entries ?? [:]
        let fm = FileManager.default
        var updates: [LibraryIndexStore.FingerprintUpdate] = []

        for url in currentFiles {
            guard updates.count < maxFingerprintWarmupPerScan else { break }
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
            updates.append(LibraryIndexStore.FingerprintUpdate(
                name: name, size: fingerprint.size, mtime: mtime,
                dateTimeOriginal: fingerprint.dateTimeOriginal, cameraSerial: fingerprint.cameraSerial))
        }

        try? await store.updateFingerprints(updates)
    }
}
