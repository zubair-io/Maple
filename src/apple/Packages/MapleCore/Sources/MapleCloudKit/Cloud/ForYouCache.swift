// ForYouCache.swift
//
// Everything the For You row needs to render before any request (#4595): the
// collection list in the order it was shown, and each card's snapshot first
// page, whose first photo is the cover. The cover's pixels are not here; they
// live in `CloudThumbCache`, keyed by server host and the asset's path, both
// stable across launches. One small JSON file per library, in a directory per
// server, read and written behind this actor so disk I/O never runs on the
// main actor.
//
// A cover is a photo the server's hidden-people and screenshot filters
// picked, so the cache bounds how long a stale one can show: the app drops
// any first page holding a photo it has just trashed (`forgetAsset`), and the
// view model ignores covers older than `maxCoverAge`. Dropping a page bumps
// the server's epoch; a refresh that began under an older epoch may have
// fetched the trashed photo, so `commit` refuses it.

import CryptoKit
import Foundation

struct ForYouSnapshot: Codable, Equatable, Sendable {
  /// A file written by a build with a different shape reads as absent.
  /// Version 3 persists `SearchAsset._id` so ID-only File Provider deletions
  /// can match cached covers (#4612).
  static let currentVersion = 3

  let version: Int
  /// In the order they were shown, so the cached order is what was on screen.
  let collections: [GeneratedSearchCard]
  let firstPages: [String: GeneratedSearchAssetPage]
  let savedAt: Date

  init(
    collections: [GeneratedSearchCard], firstPages: [String: GeneratedSearchAssetPage],
    savedAt: Date
  ) {
    self.version = Self.currentVersion
    self.collections = collections
    self.firstPages = firstPages
    self.savedAt = savedAt
  }

  /// This snapshot without any first page that shows a photo matching
  /// `isGone`, or nil when nothing matched.
  func forgetting(_ isGone: (SearchAsset) -> Bool) -> ForYouSnapshot? {
    let kept = firstPages.filter { !$0.value.results.contains(where: isGone) }
    guard kept.count < firstPages.count else { return nil }
    return ForYouSnapshot(collections: collections, firstPages: kept, savedAt: savedAt)
  }

  /// Partial folder trash keeps live rows on a mixed page, including its cover.
  func forgettingRows(_ isGone: (SearchAsset) -> Bool) -> ForYouSnapshot? {
    let kept = firstPages.compactMapValues { page -> GeneratedSearchAssetPage? in
      let results = page.results.filter { !isGone($0) }
      guard results.count < page.results.count else { return page }
      guard !results.isEmpty else { return nil }
      let total =
        page.isSnapshot
        ? results.count : max(results.count, page.total - (page.results.count - results.count))
      return GeneratedSearchAssetPage(
        results: results, total: total, isSnapshot: page.isSnapshot, more: page.more,
        capped: page.capped, isPending: page.isPending)
    }
    guard kept != firstPages else { return nil }
    return ForYouSnapshot(collections: collections, firstPages: kept, savedAt: savedAt)
  }
}

enum ForYouDeletion: Codable, Equatable, Sendable {
  case asset(host: String, assetID: String, absPath: String)
  case folder(host: String, libraryFolderID: String, folderPath: String)
}

public actor ForYouCache {
  public static let shared = ForYouCache()
  public static let appGroupSuiteName = "group.app.justmaple.aperture"

  private let directory: URL
  private let deletionsDirectory: URL?
  private var epochs: [String: Int] = [:]

  public init(directory: URL? = nil, deletionsDirectory: URL? = nil) {
    let resolvedDirectory =
      directory
      ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
      .appendingPathComponent("for-you", isDirectory: true)
    self.directory = resolvedDirectory
    self.deletionsDirectory =
      deletionsDirectory ?? (directory == nil ? Self.defaultDeletionsDirectory() : nil)
  }

  public static func defaultDeletionsDirectory() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroupSuiteName)?
      .appendingPathComponent("ForYouDeletions", isDirectory: true)
  }

  /// Record a photo deleted or trashed outside the main app (File Provider)
  /// so the main app's `ForYouCache` forgets it before rendering (#4612).
  public static func recordDeletedAsset(
    host: String, assetID: String, absPath: String = "", directory: URL? = nil
  ) {
    record(.asset(host: host, assetID: assetID, absPath: absPath), in: directory)
  }

  /// Record a folder trashed outside the main app (File Provider) so the
  /// main app's `ForYouCache` forgets every photo under it before rendering (#4612).
  public static func recordDeletedFolder(
    host: String, libraryFolderID: String, folderPath: String, directory: URL? = nil
  ) {
    record(
      .folder(host: host, libraryFolderID: libraryFolderID, folderPath: folderPath),
      in: directory)
  }

  private static func record(_ deletion: ForYouDeletion, in directory: URL?) {
    guard let dir = directory ?? defaultDeletionsDirectory(),
      let data = try? JSONEncoder().encode(deletion)
    else { return }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let file = dir.appendingPathComponent("\(UUID().uuidString).json")
    try? data.write(to: file, options: .atomic)
  }

  /// Bumped every time something is forgotten on `host`. A refresh reads it
  /// before its first request and hands it back to `commit`.
  func epoch(host: String) -> Int {
    applyRecordedDeletions()
    return epochs[host, default: 0]
  }

  /// `host` is the server's `cacheHostKey`: two servers can carry the same
  /// library id (a restored or cloned database) and must not share a set.
  func read(libraryID: String, host: String) -> ForYouSnapshot? {
    applyRecordedDeletions()
    return readSnapshot(libraryID: libraryID, host: host)
  }

  /// `read` and `epoch` in one isolated step. Read separately, a forget that
  /// lands between them pairs an unpruned snapshot with the newer epoch, and
  /// the trashed cover it shows never looks stale.
  func readWithEpoch(libraryID: String, host: String) -> (snapshot: ForYouSnapshot?, epoch: Int) {
    applyRecordedDeletions()
    return (readSnapshot(libraryID: libraryID, host: host), epochs[host, default: 0])
  }

  private func readSnapshot(libraryID: String, host: String) -> ForYouSnapshot? {
    guard let data = try? Data(contentsOf: fileURL(for: libraryID, host: host)),
      let snapshot = try? JSONDecoder().decode(ForYouSnapshot.self, from: data),
      snapshot.version == ForYouSnapshot.currentVersion
    else { return nil }
    return snapshot
  }

  /// Persist a refresh unless something was forgotten on `host` since it
  /// began. False means the refresh is stale and must not be shown either.
  func commit(
    _ snapshot: ForYouSnapshot, libraryID: String, host: String, epoch: Int
  ) -> Bool {
    guard epoch == self.epoch(host: host) else { return false }
    write(snapshot, libraryID: libraryID, host: host)
    return true
  }

  func write(_ snapshot: ForYouSnapshot, libraryID: String, host: String) {
    guard let data = try? JSONEncoder().encode(snapshot) else { return }
    let file = fileURL(for: libraryID, host: host)
    try? FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: file, options: .atomic)
  }

  /// Drop every cached first page on `host` that shows this photo, so a photo
  /// the user just trashed can't come back as a cover before the server's
  /// next answer. `assetID` is the id the app trashed by; the path catches a
  /// cached row that carries the other id form.
  public func forgetAsset(host: String, assetID: String, absPath: String = "") {
    forget(host: host) { snapshot in
      snapshot.forgetting { Self.matchesAsset($0, assetID: assetID, absPath: absPath) }
    }
  }

  /// `forgetAsset` for every photo under a trashed folder of the library
  /// `libraryFolderID`.
  public func forgetFolder(host: String, libraryFolderID: String, folderPath: String) {
    guard !folderPath.isEmpty else { return }
    forget(host: host) { snapshot in
      snapshot.forgetting {
        Self.matchesFolder($0, libraryFolderID: libraryFolderID, folderPath: folderPath)
      }
    }
  }

  /// Remove successful rows from all cached pages on this host in one pass.
  public func forgetAssetsPreservingPages(host: String, assetIDs: Set<String>) {
    guard !assetIDs.isEmpty else { return }
    forget(host: host) { snapshot in
      snapshot.forgettingRows { asset in
        assetIDs.contains(asset.id) || asset._id.map(assetIDs.contains) == true
      }
    }
  }

  /// Drain any pending File Provider deletion records from the App Group
  /// container in a single pass per host, then clear the processed markers.
  public func applyRecordedDeletions() {
    guard let deletionsDirectory else { return }
    let files =
      ((try? FileManager.default.contentsOfDirectory(
        at: deletionsDirectory, includingPropertiesForKeys: nil)) ?? [])
      .filter { $0.pathExtension == "json" }
    guard !files.isEmpty else { return }
    var byHost: [String: [(deletion: ForYouDeletion, file: URL)]] = [:]
    for file in files {
      guard let data = try? Data(contentsOf: file),
        let deletion = try? JSONDecoder().decode(ForYouDeletion.self, from: data)
      else {
        try? FileManager.default.removeItem(at: file)
        continue
      }
      switch deletion {
      case .asset(let host, _, _):
        byHost[host, default: []].append((deletion, file))
      case .folder(let host, _, let folderPath) where !folderPath.isEmpty:
        byHost[host, default: []].append((deletion, file))
      case .folder:
        try? FileManager.default.removeItem(at: file)
      }
    }
    for (host, entries) in byHost {
      let succeeded = forget(host: host) { snapshot in
        snapshot.forgetting { asset in
          entries.contains { entry in
            switch entry.deletion {
            case .asset(_, let assetID, let absPath):
              return Self.matchesAsset(asset, assetID: assetID, absPath: absPath)
            case .folder(_, let libraryFolderID, let folderPath):
              return Self.matchesFolder(
                asset, libraryFolderID: libraryFolderID, folderPath: folderPath)
            }
          }
        }
      }
      if succeeded {
        for entry in entries {
          try? FileManager.default.removeItem(at: entry.file)
        }
      }
    }
  }

  private static func matchesAsset(_ asset: SearchAsset, assetID: String, absPath: String) -> Bool {
    asset.id == assetID || asset._id == assetID
      || (!absPath.isEmpty && normalizedPath(asset.abs_path) == normalizedPath(absPath))
  }

  private static func matchesFolder(
    _ asset: SearchAsset, libraryFolderID: String, folderPath: String
  ) -> Bool {
    guard !folderPath.isEmpty, asset.folder_id == libraryFolderID else { return false }
    let normalizedFolder = normalizedPath(folderPath)
    let prefix = normalizedFolder.hasSuffix("/") ? normalizedFolder : normalizedFolder + "/"
    if isAbsolutePath(normalizedFolder) {
      return normalizedPath(asset.abs_path).hasPrefix(prefix)
    }
    guard let address = asset.address, let colon = address.firstIndex(of: ":") else { return false }
    let relativeAddress = normalizedPath(String(address[address.index(after: colon)...]))
    return relativeAddress.hasPrefix(prefix)
  }

  private static func normalizedPath(_ path: String) -> String {
    path.replacingOccurrences(of: "\\", with: "/")
  }

  private static func isAbsolutePath(_ normalizedPath: String) -> Bool {
    if normalizedPath.hasPrefix("/") { return true }
    guard let first = normalizedPath.first, first.isLetter else { return false }
    return normalizedPath.dropFirst().hasPrefix(":/")
  }

  @discardableResult
  private func forget(host: String, _ transform: (ForYouSnapshot) -> ForYouSnapshot?) -> Bool {
    epochs[host, default: 0] += 1
    let files =
      (try? FileManager.default.contentsOfDirectory(
        at: hostDirectory(host), includingPropertiesForKeys: nil)) ?? []
    var allSucceeded = true
    for file in files where file.pathExtension == "json" {
      guard let data = try? Data(contentsOf: file),
        let snapshot = try? JSONDecoder().decode(ForYouSnapshot.self, from: data),
        snapshot.version == ForYouSnapshot.currentVersion,
        let pruned = transform(snapshot)
      else { continue }
      guard let encoded = try? JSONEncoder().encode(pruned),
        (try? encoded.write(to: file, options: .atomic)) != nil
      else {
        allSucceeded = false
        continue
      }
    }
    return allSucceeded
  }

  /// Hashed so neither a host nor an id is ever trusted as a path component.
  private func hostDirectory(_ host: String) -> URL {
    directory.appendingPathComponent(Self.digest(host), isDirectory: true)
  }

  private func fileURL(for libraryID: String, host: String) -> URL {
    hostDirectory(host).appendingPathComponent("\(Self.digest(libraryID)).json")
  }

  private static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
