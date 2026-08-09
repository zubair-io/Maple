// SMBFileOperations+Trash.swift — Delete → Trash for the SMB source (issue
// #2631). SMB shares mediated through AMSMB2 have no OS-trash concept to
// call into (unlike a Finder-mounted local volume), so — per the design
// doc — SMB always uses `.maple/trash/<rel>` regardless of platform, via
// the same relocate primitive every other SMB move here uses.

import Foundation

extension SMBFileOperations {

    /// Trash a single asset (primary + sidecar) into
    /// `<shareRoot>/.maple/trash/<rel>`.
    public static func trash(_ primaryPath: String, shareRoot: String = "/",
                             transport: SMBFileTransport) async throws -> RelocateOutcome {
        let trashDir = try trashDestinationDir(for: primaryPath, shareRoot: shareRoot)
        let outcome = try await relocate(primaryPath, to: trashDir, mode: .move, collision: .autoSuffix, transport: transport)
        await writeTrashedMarker(forItemAt: outcome.primaryPath, transport: transport)
        return outcome
    }

    /// `<shareRoot>/.maple/trash/<relative-parent-directory>` — the SMB
    /// counterpart of `LocalFileOperations.trashDestinationDir`, mirroring
    /// the same API convention (`computeTrashPath` in
    /// `src/api/src/fs/trash.ts`). Works for a file or a folder: only the
    /// PARENT directory of `item` matters.
    static func trashDestinationDir(for item: String, shareRoot: String) throws -> String {
        let root = normalizedPosixDir(shareRoot)
        let parent = normalizedPosixDir((item as NSString).deletingLastPathComponent)
        let rootPrefix = root == "/" ? "/" : root + "/"
        guard parent == root || parent.hasPrefix(rootPrefix) else {
            throw FileOperationError.invalidDestination("\(item) is not under share root \(shareRoot)")
        }
        let trashRoot = posixJoin(root, ".maple/trash")
        guard parent != root else { return trashRoot }
        let relSuffix = root == "/" ? String(parent.dropFirst()) : String(parent.dropFirst(root.count + 1))
        return posixJoin(trashRoot, relSuffix)
    }

    /// Strips a trailing slash except for the bare root itself, so prefix
    /// comparisons (`hasPrefix(root + "/")`) don't get thrown off by an
    /// inconsistently-slashed caller-supplied root.
    static func normalizedPosixDir(_ path: String) -> String {
        guard path.count > 1, path.hasSuffix("/") else { return path }
        return String(path.dropLast())
    }

    // MARK: - Restore / list / purge (see `LocalFileOperations+Trash.swift`'s
    // file header for the marker scheme this mirrors)

    /// Restore a `.maple/trash`-backed item to its original location — the
    /// mirror image of `trashDestinationDir`.
    public static func restoreFromMapleTrash(_ trashedPath: String, shareRoot: String = "/",
                                             transport: SMBFileTransport) async throws -> RelocateOutcome {
        let originalDir = try originalDestinationDir(for: trashedPath, shareRoot: shareRoot)
        let outcome = try await relocate(trashedPath, to: originalDir, mode: .move, collision: .autoSuffix, transport: transport)
        await removeTrashedMarker(forItemAt: trashedPath, transport: transport)
        return outcome
    }

    /// Inverse of `trashDestinationDir`.
    static func originalDestinationDir(for trashedItem: String, shareRoot: String) throws -> String {
        let root = normalizedPosixDir(shareRoot)
        let trashRoot = posixJoin(root, ".maple/trash")
        let parent = normalizedPosixDir((trashedItem as NSString).deletingLastPathComponent)
        let trashPrefix = trashRoot == "/" ? "/" : trashRoot + "/"
        guard parent == trashRoot || parent.hasPrefix(trashPrefix) else {
            throw FileOperationError.invalidDestination("\(trashedItem) is not inside .maple/trash under \(shareRoot)")
        }
        guard parent != trashRoot else { return root }
        let relSuffix = trashRoot == "/" ? String(parent.dropFirst()) : String(parent.dropFirst(trashRoot.count + 1))
        return posixJoin(root, relSuffix)
    }

    /// Every item currently sitting in `<shareRoot>/.maple/trash`, newest
    /// first. A single recursive listing (one round-trip), split into
    /// marker directories (name → trashed date) and everything else.
    public static func listMapleTrash(shareRoot: String = "/", transport: SMBFileTransport) async -> [TrashedItem] {
        let root = normalizedPosixDir(shareRoot)
        let trashRoot = posixJoin(root, ".maple/trash")
        guard let entries = try? await transport.contentsOfDirectory(atPath: trashRoot, recursive: true) else { return [] }

        struct Entry { let path: String; let name: String; let isDir: Bool; let size: Int64 }
        let parsed: [Entry] = entries.compactMap { attrs in
            guard let name = attrs[.nameKey] as? String else { return nil }
            let isDir = attrs[.isDirectoryKey] as? Bool ?? false
            let path = (attrs[.pathKey] as? String) ?? posixJoin(trashRoot, name)
            let size = (attrs[.fileSizeKey] as? NSNumber)?.int64Value ?? 0
            return Entry(path: path, name: name, isDir: isDir, size: size)
        }

        var markerDateByPrimaryPath: [String: Date] = [:]
        for entry in parsed where entry.isDir {
            guard let parsedMarker = TrashMarker.parseMarkerDirName(entry.name) else { continue }
            let parent = (entry.path as NSString).deletingLastPathComponent
            markerDateByPrimaryPath[posixJoin(parent, parsedMarker.basename)] = parsedMarker.date
        }

        let xmpPaths = Set(parsed.filter { !$0.isDir && $0.name.lowercased().hasSuffix(".xmp") }.map(\.path))
        let trashPrefix = trashRoot == "/" ? "/" : trashRoot + "/"

        var items: [TrashedItem] = []
        for entry in parsed where !entry.isDir && !entry.name.lowercased().hasSuffix(".xmp") {
            let sidecarPath = (entry.path as NSString).deletingPathExtension.appending(".xmp")
            let rel = entry.path.hasPrefix(trashPrefix) ? String(entry.path.dropFirst(trashPrefix.count)) : entry.path
            items.append(TrashedItem(
                id: entry.path, primaryPath: entry.path,
                sidecarPath: xmpPaths.contains(sidecarPath) ? sidecarPath : nil,
                originalRelativePath: rel,
                trashedDate: markerDateByPrimaryPath[entry.path],
                size: entry.size
            ))
        }
        return items.sorted { ($0.trashedDate ?? .distantPast) > ($1.trashedDate ?? .distantPast) }
    }

    /// Permanently unlinks a trashed item — primary, sidecar, and its
    /// marker — with no further recovery. Best-effort on the sidecar/marker;
    /// the primary unlink is the one call that throws.
    ///
    /// `shareRoot` is REQUIRED and hard-guarded (review finding — same as
    /// `LocalFileOperations.permanentlyDeleteFromMapleTrash`: this is the
    /// one IRREVERSIBLE primitive in the module and must not trust a
    /// caller-supplied `TrashedItem` blindly).
    public static func permanentlyDeleteFromMapleTrash(_ item: TrashedItem, shareRoot: String = "/",
                                                        transport: SMBFileTransport) async throws {
        try requireUnderMapleTrash(item.primaryPath, shareRoot: shareRoot)
        try await transport.removeItem(atPath: item.primaryPath)
        if let sidecarPath = item.sidecarPath {
            try? await transport.removeItem(atPath: sidecarPath)
        }
        await removeTrashedMarker(forItemAt: item.primaryPath, transport: transport)
    }

    /// Throws `.invalidDestination` unless `path` resolves to somewhere
    /// strictly inside `<shareRoot>/.maple/trash` — the SMB counterpart of
    /// `LocalFileOperations.requireUnderMapleTrash`.
    static func requireUnderMapleTrash(_ path: String, shareRoot: String) throws {
        let root = normalizedPosixDir(shareRoot)
        let trashRoot = posixJoin(root, ".maple/trash")
        let trashPrefix = trashRoot == "/" ? "/" : trashRoot + "/"
        guard path.hasPrefix(trashPrefix) else {
            throw FileOperationError.invalidDestination(
                "\(path) is not inside .maple/trash under \(shareRoot) — refusing permanent delete")
        }
    }

    /// Permanently deletes every item in `<shareRoot>/.maple/trash` whose
    /// marker says it's MORE than `olderThanDays` full calendar days old —
    /// see `TrashMarker.daysElapsed`'s doc comment for the day-granularity
    /// reasoning. Items with no marker are left alone — see
    /// `LocalFileOperations.sweepExpiredMapleTrash`'s doc comment for why.
    /// Also removes orphaned markers (`sweepOrphanedMarkers`). Returns the
    /// total count of primaries purged plus orphaned markers removed.
    @discardableResult
    public static func sweepExpiredMapleTrash(shareRoot: String = "/", olderThanDays: Int = 30, now: Date = Date(),
                                              transport: SMBFileTransport) async -> Int {
        var purged = 0
        for item in await listMapleTrash(shareRoot: shareRoot, transport: transport) {
            guard let trashedDate = item.trashedDate,
                  TrashMarker.daysElapsed(since: trashedDate, now: now) > olderThanDays
            else { continue }
            if (try? await permanentlyDeleteFromMapleTrash(item, shareRoot: shareRoot, transport: transport)) != nil {
                purged += 1
            }
        }
        purged += await sweepOrphanedMarkers(shareRoot: shareRoot, transport: transport)
        return purged
    }

    /// Removes a trashed-date marker whose primary no longer exists — the
    /// SMB counterpart of `LocalFileOperations.sweepOrphanedMarkers`. A
    /// single recursive listing, then a check-and-remove pass over every
    /// marker directory found.
    static func sweepOrphanedMarkers(shareRoot: String = "/", transport: SMBFileTransport) async -> Int {
        let root = normalizedPosixDir(shareRoot)
        let trashRoot = posixJoin(root, ".maple/trash")
        guard let entries = try? await transport.contentsOfDirectory(atPath: trashRoot, recursive: true) else { return 0 }

        var removed = 0
        for attrs in entries {
            guard (attrs[.isDirectoryKey] as? Bool) == true, let name = attrs[.nameKey] as? String,
                  let parsedMarker = TrashMarker.parseMarkerDirName(name)
            else { continue }
            let markerPath = (attrs[.pathKey] as? String) ?? posixJoin(trashRoot, name)
            let primaryPath = posixJoin((markerPath as NSString).deletingLastPathComponent, parsedMarker.basename)
            guard (try? await transport.attributesOfItem(atPath: primaryPath)) == nil else { continue }
            try? await transport.removeItem(atPath: markerPath)
            removed += 1
        }
        return removed
    }

    // MARK: - Trashed-date marker

    static func writeTrashedMarker(forItemAt path: String, date: Date = Date(), transport: SMBFileTransport) async {
        let dir = (path as NSString).deletingLastPathComponent
        let markerPath = posixJoin(dir, TrashMarker.markerName(
            forItemBasename: (path as NSString).lastPathComponent, date: date))
        try? await transport.createDirectory(atPath: markerPath)
    }

    static func removeTrashedMarker(forItemAt path: String, transport: SMBFileTransport) async {
        let dir = (path as NSString).deletingLastPathComponent
        guard let entries = try? await transport.contentsOfDirectory(atPath: dir, recursive: false) else { return }
        let basename = (path as NSString).lastPathComponent
        for attrs in entries {
            guard let name = attrs[.nameKey] as? String, TrashMarker.isMarker(name, forItemBasename: basename),
                  (attrs[.isDirectoryKey] as? Bool) == true
            else { continue }
            let markerPath = (attrs[.pathKey] as? String) ?? posixJoin(dir, name)
            try? await transport.removeItem(atPath: markerPath)
        }
    }
}
