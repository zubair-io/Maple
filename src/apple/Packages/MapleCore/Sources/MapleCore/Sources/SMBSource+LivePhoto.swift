import AMSMB2
import Foundation

/// Identifiers read from the current listing's files, so a share reopened or re-listed does not
/// re-read a file whose size and mtime are unchanged.
struct LiveContentIDMemo {
  struct Entry {
    let size: Int64
    let mtime: Date
    let contentID: String?
  }

  var listing: UUID?
  var entries: [String: Entry] = [:]

  mutating func entry(for asset: SMBSource.SMBAsset, listing current: UUID) -> Entry? {
    if listing != current {
      listing = current
      entries = [:]
    }
    guard let entry = entries[asset.path], entry.size == asset.size, entry.mtime == asset.mtime
    else { return nil }
    return entry
  }

  mutating func store(_ contentID: String?, for asset: SMBSource.SMBAsset, listing current: UUID) {
    guard listing == current else { return }
    entries[asset.path] = Entry(size: asset.size, mtime: asset.mtime, contentID: contentID)
  }
}

extension SMBSource {
  /// The Live Photo halves among the listed files, keyed by share path (#5544). Pairing follows
  /// the shared rule in `LivePhotoPairing`; only a still and a clip that share a folder and stem
  /// are read, and each read is a bounded range read of that file's metadata.
  public func livePhotoLinks() async -> [String: LivePhotoLink] {
    guard let client else { return [:] }
    let listing = listingID
    let listed = Dictionary(assets.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
    return await LivePhotoPairing.links(for: Array(listed.keys)) { [self] path in
      guard let asset = listed[path] else { return nil }
      return await liveContentID(of: asset, client: client, listing: listing)
    }
  }

  private func liveContentID(of asset: SMBAsset, client: SMB2Manager, listing: UUID) async
    -> String?
  {
    if let known = liveContentIDs.entry(for: asset, listing: listing) { return known.contentID }
    guard let kind = LivePhotoPairing.Kind(filename: asset.name), asset.size > 0 else { return nil }
    let contentID = await LiveContentIdentifier.read(kind: kind, size: UInt64(asset.size)) {
      offset, length in
      try await client.contents(atPath: asset.path, range: offset..<(offset + UInt64(length)))
    }
    liveContentIDs.store(contentID, for: asset, listing: listing)
    return contentID
  }

  /// A local copy of the clip at `path`, for AVPlayer, which cannot open an SMB location. A Live
  /// Photo clip is a few seconds long, so the file is read whole. `sourceID` is the share that
  /// listed the path (#4987).
  public func liveClipFile(atPath path: String, listedBy sourceID: UUID?) async throws -> URL {
    guard let client else { throw SMBError.notConnected }
    let name = (path as NSString).lastPathComponent
    guard sourceID == nil || sourceID == listingID else { throw SMBError.foreignShare(name) }
    let data = try await client.contents(atPath: path, range: Range<UInt64>?.none)
    return try LiveClipFiles.write(data, named: name)
  }
}

/// Where SMB clips are staged for playback: a directory in the temporary folder that the system
/// reclaims, with files an hour old swept on each new write.
enum LiveClipFiles {
  private static let maxAge: TimeInterval = 3600

  static func write(_ data: Data, named name: String) throws -> URL {
    let fm = FileManager.default
    let directory = fm.temporaryDirectory.appendingPathComponent(
      "maple-live-clips", isDirectory: true)
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    sweep(directory)
    let url = directory.appendingPathComponent("\(UUID().uuidString)-\(name)")
    try data.write(to: url, options: .atomic)
    return url
  }

  private static func sweep(_ directory: URL) {
    let fm = FileManager.default
    let cutoff = Date().addingTimeInterval(-maxAge)
    let files =
      (try? fm.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
    for file in files {
      let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate
      if let modified, modified < cutoff { try? fm.removeItem(at: file) }
    }
  }
}
