// TopShelfCache.swift
//
// The shared container behind Maple TV's Top Shelf — the content tvOS shows
// in place of the app icon when Maple TV sits in the Home screen's top row.
//
// This exists because of one platform constraint: `TVTopShelfItem`'s image
// URLs are fetched by the SYSTEM, in its own process, with no opportunity to
// attach a bearer token. `/api/fs/thumb` and `/api/fs/preview` are
// bearer-gated with no query-token escape hatch (a Global Constraint — see
// `TVRemoteImage`'s header), so a remote URL simply cannot be handed to tvOS.
// Images have to be fetched by us, written to the shared App Group container,
// and handed over as `file://` URLs.
//
// The second constraint shapes the read side: `TVTopShelfContentProvider`'s
// header warns that a provider which doesn't call its completion handler
// promptly gets replaced by the static app icon. So reads here are cheap and
// isolated to the cache actor; network refreshes have a separate deadline.
//
// Both the extension and the app go through this type; neither reaches into
// the other's files.

import CryptoKit
import Foundation

/// One Top Shelf entry: a memory (or, when the day produced none, a recent
/// photo) with a cached cover image on disk.
public struct TopShelfEntry: Codable, Equatable, Sendable {
  /// Stable id. For a memory this is its collection id, which is also what
  /// the deep link carries.
  public let id: String
  public let title: String
  /// Second line — a photo count for a memory, a date for a recent photo.
  public let subtitle: String?
  /// File name inside the cache directory, not a path. Storing the name
  /// rather than an absolute URL matters: the App Group container's path is
  /// not stable across installs, so a persisted absolute path can silently
  /// point outside the current container.
  public let imageFileName: String

  public init(id: String, title: String, subtitle: String?, imageFileName: String) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.imageFileName = imageFileName
  }
}

/// What the shelf is currently showing, and when it was built.
public struct TopShelfManifest: Codable, Equatable, Sendable {
  /// Bumped only if the on-disk shape changes incompatibly. A manifest whose
  /// version this build doesn't recognise is treated as absent rather than
  /// decoded on a guess — a newer app writing a shape an older extension
  /// can't read must degrade to "refresh me", not to a crash.
  public static let currentVersion = 1

  public let version: Int
  public let generatedAt: Date
  public let entries: [TopShelfEntry]
  /// True when `entries` came from the recents fallback rather than from the
  /// day's memories. Carried so a refresh can tell "the worker produced
  /// nothing" from "we haven't looked yet".
  public let isFallback: Bool

  public init(generatedAt: Date, entries: [TopShelfEntry], isFallback: Bool) {
    self.version = Self.currentVersion
    self.generatedAt = generatedAt
    self.entries = entries
    self.isFallback = isFallback
  }
}

/// Reads and writes the Top Shelf's manifest and cover images in the shared
/// App Group container.
public actor TopShelfCache {
  /// Memories regenerate once a day, so this is comfortably tighter than the
  /// content changes while keeping the extension off the network on the vast
  /// majority of invocations.
  public static let freshnessWindow: TimeInterval = 6 * 60 * 60

  /// Most a refresh will fetch. The carousel auto-advances, and each entry
  /// costs a cover lookup plus a preview fetch, so this is the difference
  /// between a Home-screen highlight and a sync job.
  public static let maxEntries = 5

  public nonisolated let directory: URL

  /// Cache inside the shared App Group container, or nil when the container
  /// is unavailable — which means the entitlement is missing, and is a
  /// programmer error rather than a runtime condition worth recovering from.
  public init?(server: URL, libraryID: String) {
    guard
      let container = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: "group.app.justmaple.aperture")
    else { return nil }
    self.directory = Self.scopeDirectory(in: container, server: server, libraryID: libraryID)
  }

  public nonisolated static func scopeDirectory(
    in container: URL, server: URL,
    libraryID: String
  ) -> URL {
    let identity = server.absoluteString + "\n" + libraryID
    let name = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    return container.appending(path: "TopShelf").appending(path: name, directoryHint: .isDirectory)
  }

  /// Explicit directory — used by tests, which must not depend on an App
  /// Group container existing in the test host.
  public init(directory: URL) {
    self.directory = directory
  }

  private var manifestURL: URL { directory.appending(path: "manifest.json") }

  public nonisolated func imageURL(for entry: TopShelfEntry) -> URL {
    directory.appending(path: entry.imageFileName)
  }

  // MARK: - Reading

  /// The stored manifest, or nil when there is none, it can't be decoded, or
  /// it was written by a version this build doesn't understand. Every failure
  /// collapses to nil deliberately: the only useful reaction to any of them
  /// is the same one — show nothing and refresh.
  public func loadManifest() -> TopShelfManifest? {
    guard let data = try? Data(contentsOf: manifestURL),
      let manifest = try? JSONDecoder.topShelf.decode(TopShelfManifest.self, from: data),
      manifest.version == TopShelfManifest.currentVersion,
      manifest.entries.allSatisfy({ Self.validFileName($0.imageFileName) })
    else { return nil }
    return manifest
  }

  /// Whether a refresh is due. A missing manifest is stale, so a first run
  /// refreshes; `now` is injected so the rule is testable without waiting.
  public nonisolated func isStale(_ manifest: TopShelfManifest?, now: Date = Date()) -> Bool {
    guard let manifest else { return true }
    return now.timeIntervalSince(manifest.generatedAt) >= Self.freshnessWindow
  }

  // MARK: - Writing

  /// Replace the cache with `entries` and their images.
  ///
  /// Images are keyed by entry id, and any file not referenced by the new
  /// manifest is deleted — without that sweep the container would accumulate
  /// a cover per memory per day, forever, in a directory nothing else prunes.
  ///
  /// The manifest is written LAST. A reader that arrives mid-write then sees
  /// either the old manifest (whose images are still present, because the
  /// sweep runs after) or the new one, never a manifest pointing at images
  /// that haven't landed yet.
  public func write(
    entries: [TopShelfEntry], images: [String: Data], isFallback: Bool,
    now: Date = Date()
  ) throws {
    guard entries.allSatisfy({ Self.validFileName($0.imageFileName) }) else {
      throw CocoaError(.fileWriteInvalidFileName)
    }
    let available = Array(entries.filter { images[$0.id] != nil }.prefix(Self.maxEntries))
    guard !available.isEmpty else { return }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    for entry in available {
      guard let data = images[entry.id] else { continue }
      try data.write(to: imageURL(for: entry), options: .atomic)
    }

    let manifest = TopShelfManifest(generatedAt: now, entries: available, isFallback: isFallback)
    let data = try JSONEncoder.topShelf.encode(manifest)
    try data.write(to: manifestURL, options: .atomic)

    let keep = Set(available.map(\.imageFileName) + [manifestURL.lastPathComponent])
    let existing =
      (try? FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil)) ?? []
    for file in existing where !keep.contains(file.lastPathComponent) {
      try? FileManager.default.removeItem(at: file)
    }
  }

  /// File name for an entry's cover. Hashed rather than using the id
  /// directly: collection ids are server-generated and a `/` or `.` in one
  /// would escape the directory or confuse the extension.
  public static func imageFileName(forEntryID id: String) -> String {
    let hash = SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
    return "\(hash).jpg"
  }

  private static func validFileName(_ name: String) -> Bool {
    name.hasSuffix(".jpg") && !name.contains("/") && !name.contains("\\")
      && !name.contains("..") && name.count > 4
  }
}

extension JSONEncoder {
  fileprivate static var topShelf: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
  }
}

extension JSONDecoder {
  fileprivate static var topShelf: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}
