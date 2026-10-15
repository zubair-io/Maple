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
  static let currentVersion = 2

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
}

public actor ForYouCache {
  public static let shared = ForYouCache()

  private let directory: URL
  private var epochs: [String: Int] = [:]

  public init(directory: URL? = nil) {
    self.directory =
      directory
      ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
      .appendingPathComponent("for-you", isDirectory: true)
  }

  /// Bumped every time something is forgotten on `host`. A refresh reads it
  /// before its first request and hands it back to `commit`.
  func epoch(host: String) -> Int {
    epochs[host, default: 0]
  }

  /// `host` is the server's `cacheHostKey`: two servers can carry the same
  /// library id (a restored or cloned database) and must not share a set.
  func read(libraryID: String, host: String) -> ForYouSnapshot? {
    guard let data = try? Data(contentsOf: fileURL(for: libraryID, host: host)),
      let snapshot = try? JSONDecoder().decode(ForYouSnapshot.self, from: data),
      snapshot.version == ForYouSnapshot.currentVersion
    else { return nil }
    return snapshot
  }

  /// `read` and `epoch` in one isolated step. Read separately, a forget that
  /// lands between them pairs an unpruned snapshot with the newer epoch, and
  /// the trashed cover it shows never looks stale.
  func readWithEpoch(libraryID: String, host: String) -> (snapshot: ForYouSnapshot?, epoch: Int) {
    (read(libraryID: libraryID, host: host), epoch(host: host))
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
  public func forgetAsset(host: String, assetID: String, absPath: String) {
    forget(host: host) { $0.id == assetID || $0.abs_path == absPath }
  }

  /// `forgetAsset` for every photo under a trashed folder of the library
  /// `libraryFolderID`.
  public func forgetFolder(host: String, libraryFolderID: String, folderPath: String) {
    let prefix = folderPath.hasSuffix("/") ? folderPath : folderPath + "/"
    forget(host: host) { $0.folder_id == libraryFolderID && $0.abs_path.hasPrefix(prefix) }
  }

  private func forget(host: String, _ isGone: (SearchAsset) -> Bool) {
    epochs[host, default: 0] += 1
    let files =
      (try? FileManager.default.contentsOfDirectory(
        at: hostDirectory(host), includingPropertiesForKeys: nil)) ?? []
    for file in files where file.pathExtension == "json" {
      guard let data = try? Data(contentsOf: file),
        let snapshot = try? JSONDecoder().decode(ForYouSnapshot.self, from: data),
        let pruned = snapshot.forgetting(isGone),
        let encoded = try? JSONEncoder().encode(pruned)
      else { continue }
      try? encoded.write(to: file, options: .atomic)
    }
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
