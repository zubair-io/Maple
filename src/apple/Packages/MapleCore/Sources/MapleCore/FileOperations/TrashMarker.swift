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
    /// `.restored-` marks an SMB trash item whose verified copy was published by
    /// a copy-only restore (#4139): it is hidden from listings and left for the
    /// expiry sweep, the only deleter.
    enum Kind: String, CaseIterable {
        case trashed = ".trashed-"
        case restored = ".restored-"
    }

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
    static func markerName(forItemBasename basename: String, date: Date, kind: Kind = .trashed)
        -> String
    {
        basename + kind.rawValue + dayFormatter.string(from: date)
    }

    /// Parses a marker directory's own basename back into the item
    /// basename it marks, the date it records and its kind. `nil` if
    /// `name` isn't shaped like a marker at all.
    static func parseMarkerDirName(_ name: String) -> (basename: String, date: Date, kind: Kind)? {
        Kind.allCases.lazy.compactMap { kind -> (basename: String, date: Date, kind: Kind)? in
            guard let range = name.range(of: kind.rawValue, options: .backwards) else { return nil }
            let basename = String(name[..<range.lowerBound])
            guard !basename.isEmpty,
                let date = dayFormatter.date(from: String(name[range.upperBound...]))
            else { return nil }
            return (basename, date, kind)
        }.first
    }

    /// `true` when `name` is shaped like a marker for ANY item — used to
    /// skip markers while enumerating a trash directory's own contents.
    static func isAnyMarker(_ name: String) -> Bool {
        parseMarkerDirName(name) != nil
    }

    /// `true` when `name` is a marker of any kind for `itemBasename`.
    static func isMarker(_ name: String, forItemBasename itemBasename: String) -> Bool {
        parseMarkerDirName(name)?.basename == itemBasename
    }

    /// The date `name` records, if `name` is a `kind` marker for `itemBasename`.
    static func date(fromMarkerName name: String, itemBasename: String, kind: Kind = .trashed)
        -> Date?
    {
        guard let parsed = parseMarkerDirName(name), parsed.basename == itemBasename,
            parsed.kind == kind
        else { return nil }
        return parsed.date
    }

    /// A restore staging copy's name inside `.maple/restore-staging`; the
    /// leading day lets the expiry sweep age out copies an interrupted
    /// restore left behind.
    static func restoreStagingName(date: Date, id: UUID) -> String {
        dayFormatter.string(from: date) + ".tmp." + id.uuidString
    }

    static func restoreStagingDate(_ name: String) -> Date? {
        guard let range = name.range(of: ".tmp.") else { return nil }
        return dayFormatter.date(from: String(name[..<range.lowerBound]))
    }

    /// Whole calendar days elapsed between `trashedDate` and `now`, both
    /// truncated to midnight UTC first (`dayFormatter`'s own day-only
    /// granularity — the marker never stored a time-of-day to begin with).
    ///
    /// Review finding: comparing raw `timeIntervalSince` against
    /// `days * 86_400` purges up to ~24h EARLY for an item trashed late in
    /// the day (23:59 today reads as "1 day old" the instant midnight
    /// ticks over). A day-to-day comparison, biased toward retaining
    /// longer, is the correct read of "30-day auto-purge" — `sweep...`
    /// below purges only once this is STRICTLY GREATER than the configured
    /// threshold (i.e. day 31+ for a 30-day policy), never merely equal.
    static func daysElapsed(since trashedDate: Date, now: Date) -> Int {
        // MUST use the same UTC time zone `dayFormatter` parses marker
        // names with — the marker only ever stores a date (never a
        // time-of-day), so `dayFormatter.date(from:)` always reconstructs
        // midnight UTC. Truncating THAT with a calendar in the device's
        // local time zone (the `Calendar()` default) can shift it onto a
        // different local day depending on the device's UTC offset,
        // silently gaining or losing a day versus the intended comparison.
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let markerDay = cal.startOfDay(for: trashedDate)
        let todayDay = cal.startOfDay(for: now)
        return cal.dateComponents([.day], from: markerDay, to: todayDay).day ?? 0
    }
}
