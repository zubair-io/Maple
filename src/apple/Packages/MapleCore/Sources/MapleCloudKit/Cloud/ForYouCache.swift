// ForYouCache.swift
//
// Everything the For You row needs to render before any request (#4595): the
// collection list in the order it was shown, and each card's snapshot first
// page, whose first photo is the cover. The cover's pixels are not here; they
// live in `CloudThumbCache`, keyed by server host and the asset's path, both
// stable across launches. One small JSON file per library in the caches
// directory, read and written behind this actor so disk I/O never runs on
// the main actor.

import CryptoKit
import Foundation

struct ForYouSnapshot: Codable, Equatable, Sendable {
  /// A file written by a build with a different shape reads as absent.
  static let currentVersion = 1

  let version: Int
  /// In the order they were shown, so the cached order is what was on screen.
  let collections: [GeneratedSearchCard]
  let firstPages: [String: GeneratedSearchAssetPage]

  init(collections: [GeneratedSearchCard], firstPages: [String: GeneratedSearchAssetPage]) {
    self.version = Self.currentVersion
    self.collections = collections
    self.firstPages = firstPages
  }
}

public actor ForYouCache {
  public static let shared = ForYouCache()

  private let directory: URL

  public init(directory: URL? = nil) {
    self.directory =
      directory
      ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("app.justmaple.aperture", isDirectory: true)
      .appendingPathComponent("for-you", isDirectory: true)
  }

  func read(libraryID: String) -> ForYouSnapshot? {
    guard let data = try? Data(contentsOf: fileURL(for: libraryID)),
      let snapshot = try? JSONDecoder().decode(ForYouSnapshot.self, from: data),
      snapshot.version == ForYouSnapshot.currentVersion
    else { return nil }
    return snapshot
  }

  func write(_ snapshot: ForYouSnapshot, libraryID: String) {
    guard let data = try? JSONEncoder().encode(snapshot) else { return }
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try? data.write(to: fileURL(for: libraryID), options: .atomic)
  }

  /// Hashed so an id is never trusted as a path component.
  private func fileURL(for libraryID: String) -> URL {
    let digest = SHA256.hash(data: Data(libraryID.utf8)).map { String(format: "%02x", $0) }
    return directory.appendingPathComponent("\(digest.joined()).json")
  }
}
