// ExternalRenameMatcher.swift — pure external-rename matching (issue #2656).
//
// A file renamed outside Maple (Finder) leaves the old path missing and a
// new, unindexed path present in the same folder. This module decides,
// from a cheap fingerprint alone, whether a "missing" candidate and a "new"
// candidate are plausibly the SAME photo — never a full checksum, since
// RAWs are large (matches the server-side design, #2655).
//
// MANDATORY false-positive guard: a match fires only when EXACTLY ONE
// missing candidate and EXACTLY ONE new candidate share a fingerprint.
// Two genuinely different photos that happen to share a size (or any other
// partial overlap) must never be merged — this operation moves user edit
// data, so a wrong match silently attaches one photo's edits to another.
// Every other shape — zero matches, or more than one candidate on either
// side — declines for that fingerprint rather than guessing.
//
// Deliberately pure and I/O-free: no `FileManager`, no `URL` resolution, no
// EXIF reads. Callers (`ExternalRenameReconciler`) own gathering real
// candidates from disk / the `LibraryIndex` cache; this type only ever sees
// already-computed values, which is what makes it directly and thoroughly
// unit-testable without touching a filesystem.

import Foundation

// MARK: - ExternalRenameFingerprint

/// A cheap, non-cryptographic identity signal for a single photo: file
/// size plus EXIF `DateTimeOriginal` plus (when available) the camera's
/// body serial number. `dateTimeOriginal` is load-bearing and REQUIRED —
/// a fingerprint built from size alone is exactly the false-positive shape
/// this whole module exists to prevent, so `ExternalRenameFingerprint.live`
/// (the production provider, `ExternalRenameFingerprint+Live.swift`)
/// returns `nil` rather than degrade to a size-only fingerprint whenever
/// EXIF can't be read. `cameraSerial` is optional — many cameras never
/// surface it — and only tightens a match when both sides have one.
public struct ExternalRenameFingerprint: Sendable, Hashable {
    public let size: Int64
    public let dateTimeOriginal: String
    public let cameraSerial: String?

    public init(size: Int64, dateTimeOriginal: String, cameraSerial: String? = nil) {
        self.size = size
        self.dateTimeOriginal = dateTimeOriginal
        self.cameraSerial = cameraSerial
    }
}

// MARK: - ExternalRenameMatcher

public enum ExternalRenameMatcher {

    /// One side of a candidate rename pair: a path (missing or newly-seen)
    /// plus the fingerprint computed for it. `path` is a plain absolute
    /// path string, not a `URL` — the matcher never touches disk, so there
    /// is nothing a `URL` buys here over a string callers already have.
    public struct Candidate: Sendable, Equatable {
        public let path: String
        public let fingerprint: ExternalRenameFingerprint

        public init(path: String, fingerprint: ExternalRenameFingerprint) {
            self.path = path
            self.fingerprint = fingerprint
        }
    }

    /// A confirmed rename: `oldPath` (a `missing` candidate) is the same
    /// photo as `newPath` (a `new` candidate).
    public struct Match: Sendable, Equatable {
        public let oldPath: String
        public let newPath: String

        public init(oldPath: String, newPath: String) {
            self.oldPath = oldPath
            self.newPath = newPath
        }
    }

    /// Match `missing` candidates (previously-known paths that vanished)
    /// against `new` candidates (previously-unknown paths that appeared) by
    /// fingerprint. Returns one `Match` per fingerprint that has EXACTLY one
    /// candidate on each side — every other fingerprint (present on only one
    /// side, or with more than one candidate on either side) is declined
    /// silently; `ExternalRenameReconciler` is responsible for logging
    /// declines it cares about, since only it knows the folder context worth
    /// putting in a log line.
    ///
    /// Output order is deterministic (sorted by `oldPath`) so callers and
    /// tests never depend on `Dictionary`'s unordered iteration.
    public static func match(missing: [Candidate], new: [Candidate]) -> [Match] {
        var missingByFingerprint: [ExternalRenameFingerprint: [Candidate]] = [:]
        for candidate in missing {
            missingByFingerprint[candidate.fingerprint, default: []].append(candidate)
        }
        var newByFingerprint: [ExternalRenameFingerprint: [Candidate]] = [:]
        for candidate in new {
            newByFingerprint[candidate.fingerprint, default: []].append(candidate)
        }

        var matches: [Match] = []
        for (fingerprint, missingGroup) in missingByFingerprint {
            guard missingGroup.count == 1,
                  let newGroup = newByFingerprint[fingerprint],
                  newGroup.count == 1
            else { continue }
            matches.append(Match(oldPath: missingGroup[0].path, newPath: newGroup[0].path))
        }
        return matches.sorted { $0.oldPath < $1.oldPath }
    }
}
