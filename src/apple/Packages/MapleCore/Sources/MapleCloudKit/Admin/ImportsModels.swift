// ImportsModels.swift — wire types for the Imports wizard (#2773).
//
// Covers `/api/imports/*` plus the slice of `/api/fs` the wizard's source
// picker needs (`routes/imports.ts`, `routes/fs.ts`). The picker uses
// `/api/fs/dir-fast`, NOT the EXIF-enriched `/api/fs/dir` that
// `CloudFoldersClient.listDir` / `FsDirListing` already cover — dir-fast is
// a distinct route with a distinct (narrower) response shape, so it gets
// its own decode type here rather than overloading `FsDirListing`.

import Foundation

// MARK: - Step 1: source picker

/// `GET /api/fs/dir-fast?path=` response. The picker only ever needs
/// `parent` (to disable Up at the MAPLE_ROOTS jail root — a null parent
/// means "at the root") and `dirs` (to drill down); the real response also
/// carries an `images` array, left off this type since nothing here reads
/// it. `dirs` entries are `{name, path, mtime}` — identical in shape to
/// `/api/fs/dir`'s subfolder entries, so this reuses `FsDirEntry` rather
/// than declaring a second identical struct.
public struct ImportsDirListing: Decodable, Sendable, Equatable {
  public let path: String
  public let parent: String?
  public let dirs: [FsDirEntry]
}

// MARK: - Step 2: scan

/// One `${year}/${mm}` capture-date group from `POST /api/imports/scan`.
/// Field names match the server's `ScanBucket` (`imports/scan.ts`)
/// verbatim — the server returns them camelCase, unlike the snake_case
/// `source_root`-style fields elsewhere in this file, so no `CodingKeys`
/// remapping is needed here.
public struct ImportScanBucket: Decodable, Sendable, Equatable, Identifiable {
  public var id: String { key }

  /// Stable key — the label-override map (`ImportReviewForm`) and the
  /// create request's `labels` are both keyed on this.
  public let key: String
  public let year: String
  /// Two-digit month; also the bucket's default label.
  public let mm: String
  public let fileCount: Int
  public let imageCount: Int
  public let movieCount: Int
  public let sidecarCount: Int
  public let totalBytes: Int64
  /// Where this bucket's files land when its label is left blank.
  public let defaultDest: String
  /// Files that would instead join an already-indexed photo captured
  /// within 30 minutes of them — 0 when no library was given to the scan,
  /// or nothing matched. See `ImportReviewForm.hasOverride`: an explicit
  /// label always outranks this, so the note built from this count must
  /// hide once one is set.
  public let nearbyMatchCount: Int
  public let nearbyMatchFolders: [String]

  /// Explicit memberwise init — a `public` struct gets no synthesized one,
  /// and previews/tests need to build a bucket without a live scan.
  public init(
    key: String, year: String, mm: String, fileCount: Int, imageCount: Int, movieCount: Int,
    sidecarCount: Int, totalBytes: Int64, defaultDest: String, nearbyMatchCount: Int,
    nearbyMatchFolders: [String]
  ) {
    self.key = key
    self.year = year
    self.mm = mm
    self.fileCount = fileCount
    self.imageCount = imageCount
    self.movieCount = movieCount
    self.sidecarCount = sidecarCount
    self.totalBytes = totalBytes
    self.defaultDest = defaultDest
    self.nearbyMatchCount = nearbyMatchCount
    self.nearbyMatchFolders = nearbyMatchFolders
  }
}

public struct ImportScanTotals: Decodable, Sendable, Equatable {
  public let files: Int
  public let images: Int
  public let movies: Int
  public let sidecars: Int
  public let bytes: Int64
}

public struct ImportScanResult: Decodable, Sendable, Equatable {
  public let sourceRoot: String
  public let buckets: [ImportScanBucket]
  public let totals: ImportScanTotals

  enum CodingKeys: String, CodingKey {
    case sourceRoot = "source_root"
    case buckets
    case totals
  }
}

/// `POST /api/imports/scan` body. `libraryID` is optional server-side (the
/// endpoint works before a library is chosen) but should be sent whenever
/// known — it's what lets the server also resolve nearby-asset matches.
/// Custom `encode(to:)` rather than relying on synthesis: an absent
/// `library_id` must OMIT the key (Elysia's `t.Optional(t.String())`
/// rejects an explicit `null` there), matching the explicit-encode
/// convention the other Admin clients use for anything the wire contract
/// cares about.
public struct ImportScanRequest: Encodable, Sendable, Equatable {
  public let sourceRoot: String
  public let libraryID: String?

  public init(sourceRoot: String, libraryID: String?) {
    self.sourceRoot = sourceRoot
    self.libraryID = libraryID
  }

  enum CodingKeys: String, CodingKey {
    case sourceRoot = "source_root"
    case libraryID = "library_id"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(sourceRoot, forKey: .sourceRoot)
    try c.encodeIfPresent(libraryID, forKey: .libraryID)
  }
}

// MARK: - Step 3: create + progress

/// `POST /api/imports` body. Two shapes in one type, mirroring the web's
/// `queue()`: the manual path sends `labels` (and omits `auto`), Auto
/// Import sends `auto: true` (and omits `labels` — the server ignores it
/// when `auto` is set, but sending it anyway would be misleading about
/// which path actually ran).
///
/// A blank bucket label must never reach this request at all — see
/// `ImportReviewForm.requestLabels()`, which drops blank entries before
/// they get here. This type only guarantees the OUTER `labels`/`auto` keys
/// follow the omit-when-absent contract; the inner per-bucket blankness
/// rule is `ImportReviewForm`'s job.
public struct ImportCreateRequest: Encodable, Sendable, Equatable {
  public let sourceRoot: String
  public let libraryID: String
  public let labels: [String: String]?
  public let auto: Bool?

  public init(sourceRoot: String, libraryID: String, labels: [String: String]?, auto: Bool?) {
    self.sourceRoot = sourceRoot
    self.libraryID = libraryID
    self.labels = labels
    self.auto = auto
  }

  enum CodingKeys: String, CodingKey {
    case sourceRoot = "source_root"
    case libraryID = "library_id"
    case labels
    case auto
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(sourceRoot, forKey: .sourceRoot)
    try c.encode(libraryID, forKey: .libraryID)
    try c.encodeIfPresent(labels, forKey: .labels)
    try c.encodeIfPresent(auto, forKey: .auto)
  }
}

public enum ImportStatus: String, Decodable, Sendable, Equatable {
  case pending
  case running
  case done
  case failed
  case cancelled
}

public struct ImportProgress: Decodable, Sendable, Equatable {
  public let current: Int
  public let total: Int
}

public struct ImportCounts: Decodable, Sendable, Equatable {
  public let copied: Int
  public let skipped: Int
  public let failed: Int
}

/// `GET /api/imports/:id?summary=1` (and the `imports` array of
/// `GET /api/imports`) — everything except the per-file `files` array,
/// which is the only field that grows with file count. Progress polling
/// must always use the `summary=1` variant; see `ImportsClient.status`.
public struct ImportSummary: Decodable, Sendable, Equatable, Identifiable {
  public let id: String
  public let status: ImportStatus
  public let sourceRoot: String
  public let libraryID: String
  public let libraryRoot: String
  /// Auto Import awaiting the worker's deferred scan (files not yet
  /// resolved) — see `routes/imports.ts`'s `scan_pending`.
  public let scanPending: Bool
  public let progress: ImportProgress
  public let counts: ImportCounts
  public let error: String?
  public let cancelRequested: Bool
  public let createdAt: String
  public let updatedAt: String

  enum CodingKeys: String, CodingKey {
    case id
    case status
    case sourceRoot = "source_root"
    case libraryID = "library_id"
    case libraryRoot = "library_root"
    case scanPending = "scan_pending"
    case progress
    case counts
    case error
    case cancelRequested = "cancel_requested"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
  }

  /// 0 while `progress.total` is still 0 (job just created, nothing
  /// enumerated yet) rather than dividing by zero.
  public var percent: Int {
    guard progress.total > 0 else { return 0 }
    return Int((Double(progress.current) / Double(progress.total) * 100).rounded())
  }

  /// Polling must stop here — a terminal job never produces another
  /// status/progress transition.
  public var isTerminal: Bool {
    status == .done || status == .failed || status == .cancelled
  }

  /// Mirrors the web's `retryable()` (`imports-panel.service.ts`): a
  /// failed job is always retryable — the server either recovers its
  /// failed file rows or, for a scan-level failure that never produced
  /// files, re-scans from scratch — while a `done` job only qualifies when
  /// it left failed files behind.
  public var isRetryable: Bool {
    status == .failed || (status == .done && counts.failed > 0)
  }
}
