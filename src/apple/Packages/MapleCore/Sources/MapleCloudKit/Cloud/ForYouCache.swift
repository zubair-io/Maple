// ForYouCache.swift
//
// Everything the For You row needs to render before any request (#4595): the
// collection list in the order it was shown, and each card's snapshot first
// page, whose first photo is the cover. The cover's pixels are not here; they
// live in `CloudThumbCache`, keyed by server host and the asset's path, both
// stable across launches. One small JSON file per server and library in the
// caches directory, read and written behind this actor so disk I/O never runs
// on the main actor.
//
// A cover is a photo the server's hidden-people and screenshot filters
// picked, so the cache bounds how long a stale one can show: the app drops
// any first page holding a photo it has just trashed (`forgetAssets`), even
// one a refresh already in flight fetched, and the view model ignores covers
// older than `maxCoverAge`.

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
  /// Photos trashed during this process. A refresh that fetched a page
  /// before the trash landed must not write that photo back as a cover.
  private var trashedPaths: Set<String> = []
  private var trashedFolders: [String] = []

  public init(directory: URL? = nil) {
    self.directory =
      directory
      ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
      .appendingPathComponent("for-you", isDirectory: true)
  }

  /// `host` is the server's `cacheHostKey`: two servers can carry the same
  /// library id (a restored or cloned database), and must not share a row.
  func read(libraryID: String, host: String) -> ForYouSnapshot? {
    guard let data = try? Data(contentsOf: fileURL(for: libraryID, host: host)),
      let snapshot = try? JSONDecoder().decode(ForYouSnapshot.self, from: data),
      snapshot.version == ForYouSnapshot.currentVersion
    else { return nil }
    return snapshot
  }

  func write(_ snapshot: ForYouSnapshot, libraryID: String, host: String) {
    let committed = snapshot.forgetting(isTrashed) ?? snapshot
    guard let data = try? JSONEncoder().encode(committed) else { return }
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try? data.write(to: fileURL(for: libraryID, host: host), options: .atomic)
  }

  /// Drop every cached first page that shows one of these photos, in every
  /// library, so a photo the user just trashed can't come back as a cover
  /// before the server's next answer.
  public func forgetAssets(absPaths: Set<String>) {
    trashedPaths.formUnion(absPaths)
    forget { absPaths.contains($0.abs_path) }
  }

  /// `forgetAssets` for every photo under a trashed folder.
  public func forgetAssets(under folderPath: String) {
    let prefix = folderPath.hasSuffix("/") ? folderPath : folderPath + "/"
    trashedFolders.append(prefix)
    forget { $0.abs_path.hasPrefix(prefix) }
  }

  private func isTrashed(_ asset: SearchAsset) -> Bool {
    trashedPaths.contains(asset.abs_path)
      || trashedFolders.contains { asset.abs_path.hasPrefix($0) }
  }

  private func forget(_ isGone: (SearchAsset) -> Bool) {
    let files =
      (try? FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil)) ?? []
    for file in files where file.pathExtension == "json" {
      guard let data = try? Data(contentsOf: file),
        let snapshot = try? JSONDecoder().decode(ForYouSnapshot.self, from: data),
        let pruned = snapshot.forgetting(isGone),
        let encoded = try? JSONEncoder().encode(pruned)
      else { continue }
      try? encoded.write(to: file, options: .atomic)
    }
  }

  /// Hashed so an id is never trusted as a path component.
  private func fileURL(for libraryID: String, host: String) -> URL {
    let digest = SHA256.hash(data: Data("\(host)|\(libraryID)".utf8)).map {
      String(format: "%02x", $0)
    }
    return directory.appendingPathComponent("\(digest.joined()).json")
  }
}
