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
// `LibraryIndexStore` for the folder it has open and passes it in here, so
// every read/write this module (and the `applyExternalRename` calls it
// makes) performs for that folder serializes through that SAME actor
// instance rather than paying for a fresh one per call. Correctness no
// longer depends on this sharing (#2844): `LibraryIndexStore` re-reads
// `index.json` fresh on every `load()`/mutation rather than trusting a
// cached snapshot, so even an independent instance racing this one over the
// same file picks up the other's writes instead of silently discarding them
// on its own next `save()`.

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

    /// `existing.mtime` came from `index.json` via `LibraryIndexStore.load()`
    /// — an ISO8601-encoded `Date`, which formats to WHOLE seconds only (it
    /// TRUNCATES any fractional part, it does not round it) — while `mtime`
    /// is a fresh `FileManager` `.modificationDate` `stat`, which routinely
    /// carries sub-second precision on APFS. Comparing those with plain
    /// `Date` equality made an utterly unchanged file look "changed" on
    /// every scan whose `LibraryIndexStore` had to re-read `index.json`
    /// from disk rather than reuse an in-memory `Date` it still held from
    /// writing that same entry a moment earlier — which, since #2844, is
    /// EVERY scan (`LibraryIndexStore` no longer caches across calls; see
    /// its doc comment for why trusting a cache was the actual bug).
    ///
    /// A tolerance window fixes it; `.rounded()` on each side independently
    /// does NOT — a file with a real mtime of X.7s round-trips through the
    /// truncating encoder as stored = X.0s, which rounds DOWN to X, while a
    /// fresh stat of X.7s rounds UP to X+1: a guaranteed mismatch for
    /// roughly half of all totally unchanged files, defeating the very
    /// check this exists for. Comparing the absolute difference against a
    /// 1-second window instead tolerates the encoder's truncation
    /// regardless of which side of a second boundary the fractional part
    /// falls on.
    private static func sameWithinOneSecond(_ a: Date?, _ b: Date?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (a?, b?): return abs(a.timeIntervalSince1970 - b.timeIntervalSince1970) < 1.0
        default: return false
        }
    }

    /// Skips the (EXIF-reading) provider call entirely when a file's size
    /// and mtime match what's already cached AND a `dateTimeOriginal` is
    /// already on file — mirrors `MapleIdCacheStore.lookup`'s
    /// size/mtime-gated skip. Bounded to `maxFingerprintWarmupPerScan`
    /// files needing a refresh per call (see its doc comment) and writes
    /// every change collected this call in exactly ONE `store.
    /// updateFingerprints(_:)` — one atomic JSON rewrite no matter how many
    /// entries changed, instead of one rewrite per file.
    ///
    /// A file the provider comes back `nil` for (a PNG screenshot, a video,
    /// a corrupt RAW — anything with no readable EXIF) still gets an entry
    /// recorded, with `dateTimeOriginal`/`cameraSerial` left `nil` but
    /// `fingerprintAttempted` stamped `true` (see that field's doc comment
    /// on `LibraryIndex.LibraryEntry`) — this is what makes the failed
    /// attempt count against `maxFingerprintWarmupPerScan` (so a folder of
    /// thousands of EXIF-less files can't blow through the cap in one
    /// scan) AND lets the freshness check below skip it on every later scan
    /// instead of re-reading its EXIF every single time.
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
               existing.size == size, sameWithinOneSecond(existing.mtime, mtime),
               existing.dateTimeOriginal != nil || existing.fingerprintAttempted == true {
                continue
            }
            guard let fingerprint = fingerprintProvider(url) else {
                // A genuine attempt that found no EXIF — record the
                // sentinel so this file isn't re-read every scan, and so it
                // still counts toward this scan's cap.
                updates.append(LibraryIndexStore.FingerprintUpdate(
                    name: name, size: size, mtime: mtime, dateTimeOriginal: nil, cameraSerial: nil))
                continue
            }
            updates.append(LibraryIndexStore.FingerprintUpdate(
                name: name, size: fingerprint.size, mtime: mtime,
                dateTimeOriginal: fingerprint.dateTimeOriginal, cameraSerial: fingerprint.cameraSerial))
        }

        try? await store.updateFingerprints(updates)
    }
}
