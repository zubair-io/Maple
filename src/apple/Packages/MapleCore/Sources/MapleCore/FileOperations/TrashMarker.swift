// TrashMarker.swift — trashed-date bookkeeping for `.maple/trash`-backed
// sources (issue #2653). Shared by the Local (iOS/iPadOS) and SMB trash
// engines, both of which need a "when was this trashed" timestamp to
// implement the design doc's 30-day auto-purge.
//
// Why not just use the file's mtime? `relocate`'s copy-verify step
// deliberately PRESERVES the source file's original modification date
// (docs/caching.md — a plain move must not look like an edit to the
// mtime-keyed preview cache), so the trashed file's mtime is the PHOTO's
// mtime, not the trash time — and repurposing it would corrupt the photo's
// real capture-adjacent mtime the moment Restore moved it back out.
//
// Why not prefix the date onto the filename, the way the PhotoKit orphan
// sweeper does (`{YYYY-MM-DD}-{identifier}.xmp`, docs/spec/08-io.md §
// "Deletion sweep")? Trashing preserves the tree's relative structure so
// Restore can reconstruct it (design doc, "Delete → Trash → Restore") —
// renaming the file itself would break that.
//
// So each trashed item gets a companion marker: an EMPTY DIRECTORY sibling
// named `<basename>.trashed-YYYY-MM-DD`. An empty directory is something
// both engines can create, list, and remove with the exact same three
// primitives (`createDirectory`/list/`removeItem`) they already use for
// everything else — `SMBFileTransport` has no "write these bytes"
// primitive, only directory and whole-file operations, so a marker FILE
// isn't an option on the SMB side. The trash directory listing stays the
// only state, matching the PhotoKit sweeper's `.orphaned/` design.
import Foundation

enum TrashMarker {
    private static let suffix = ".trashed-"

    private static let dayFormatter: DateFormatter = {
        let df = DateFormatter()
        df.calendar = Calendar(identifier: .gregorian)
        df.locale = Locale(identifier: "en_US_POSIX")
        df.timeZone = TimeZone(identifier: "UTC")
        df.dateFormat = "yyyy-MM-dd"
        return df
    }()

    /// The marker's own basename, a sibling of the trashed item — e.g.
    /// `IMG_1.dng.trashed-2026-08-09` next to `IMG_1.dng`.
    static func markerName(forItemBasename basename: String, date: Date) -> String {
        basename + suffix + dayFormatter.string(from: date)
    }

    /// Parses a marker directory's own basename back into the item
    /// basename it marks and the date it was trashed. `nil` if `name`
    /// isn't shaped like a marker at all.
    static func parseMarkerDirName(_ name: String) -> (basename: String, date: Date)? {
        guard let range = name.range(of: suffix, options: .backwards) else { return nil }
        let basename = String(name[..<range.lowerBound])
        guard !basename.isEmpty, let date = dayFormatter.date(from: String(name[range.upperBound...]))
        else { return nil }
        return (basename, date)
    }

    /// `true` when `name` is shaped like a marker for ANY item — used to
    /// skip markers while enumerating a trash directory's own contents.
    static func isAnyMarker(_ name: String) -> Bool {
        parseMarkerDirName(name) != nil
    }

    /// `true` when `name` is specifically the marker for `itemBasename`.
    static func isMarker(_ name: String, forItemBasename itemBasename: String) -> Bool {
        parseMarkerDirName(name)?.basename == itemBasename
    }

    /// The trashed date encoded in `name`, if `name` is a marker for
    /// `itemBasename`.
    static func date(fromMarkerName name: String, itemBasename: String) -> Date? {
        guard let parsed = parseMarkerDirName(name), parsed.basename == itemBasename else { return nil }
        return parsed.date
    }
}
