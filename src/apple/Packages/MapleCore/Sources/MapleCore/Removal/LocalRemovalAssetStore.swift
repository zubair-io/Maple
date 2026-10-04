import Darwin
// Immutable local companion publication (#3940 / #1472). Returning prepared
// metadata is not a Saved signal; the caller must confirm its XMP commit.
import Foundation

public actor LocalRemovalAssetStore {
  private let directory: URL
  private let rawURL: URL

  public init(rawURL: URL) {
    self.rawURL = rawURL
    directory = rawURL.deletingLastPathComponent()
      .appendingPathComponent(".maple/inpaint", isDirectory: true)
  }

  public func publish(request: String, prior: String, mask: Data, patch: Data) throws -> String {
    try Task.checkCancellation()
    let records = try RemovalBridge.prepare(
      request: request, prior: prior, mask: mask, patch: patch)
    try RemovalBridge.verifySource(records: records, rawURL: rawURL)
    let names = try RemovalBridge.assetNames(records: records)
    let publicationDirectories = try createDirectory()
    try publish(mask, names: names)
    try Task.checkCancellation()
    try publish(patch, names: names)
    try syncDirectories(publicationDirectories)
    // A previously accepted edit with missing assets must not disappear from
    // the proposed stack. Publication may leave safe orphans if this fails.
    _ = try readAssets(records: records)
    try Task.checkCancellation()
    return records
  }

  public func readAssets(records: String) throws -> [String: Data] {
    try Self.readAssets(records: records, directory: directory)
  }

  nonisolated static func readAssets(records: String, directory: URL) throws -> [String: Data] {
    let names = try RemovalBridge.assetNames(records: records)
    return try Dictionary(
      uniqueKeysWithValues: names.map { name in
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else {
          throw RemovalError.missingCompanion(name)
        }
        let data = try Data(contentsOf: url)
        try RemovalBridge.verifyAsset(name: name, data: data)
        return (name, data)
      })
  }

  /// Publish all referenced companions at a relocation destination before its
  /// primary/sidecar visibility step (#3944). This is not a Saved signal. The
  /// local relocation/trash integration remains tracked by that issue.
  /// Source companions stay in place: other photos and undo history can share
  /// their content identities; unlinking requires a reachability proof.
  public func copyAssets(records: String, to destinationRawURL: URL) async throws {
    try Task.checkCancellation()
    try RemovalBridge.verifySource(records: records, rawURL: rawURL)
    // Validate the entire source set before creating anything at destination.
    let assets = try readAssets(records: records)
    let destination = LocalRemovalAssetStore(rawURL: destinationRawURL)
    try await destination.importAssets(records: records, assets: assets)
  }

  private func importAssets(records: String, assets: [String: Data]) throws {
    let names = try RemovalBridge.assetNames(records: records)
    guard Set(names) == Set(assets.keys) else {
      throw RemovalError.invalid("Relocation companion set differs from the sidecar")
    }
    for name in names {
      try RemovalBridge.verifyAsset(name: name, data: assets[name]!)
    }
    guard !names.isEmpty else { return }
    let publicationDirectories = try createDirectory()
    for name in names {
      try Task.checkCancellation()
      try publish(assets[name]!, names: [name])
    }
    try syncDirectories(publicationDirectories)
    _ = try readAssets(records: records)
  }

  private func publish(_ data: Data, names: [String]) throws {
    let digest = try RemovalBridge.digest(data)
    guard let hex = digest.split(separator: ":").last,
      let name = names.first(where: { $0.hasPrefix(String(hex) + ".") })
    else { throw RemovalError.invalid("Prepared removal does not reference this companion") }
    try RemovalBridge.verifyAsset(name: name, data: data)
    let target = directory.appendingPathComponent(name)
    if FileManager.default.fileExists(atPath: target.path) {
      try RemovalBridge.verifyAsset(name: name, data: Data(contentsOf: target))
      return
    }
    let temporary = directory.appendingPathComponent(".\(UUID().uuidString).tmp")
    defer { try? FileManager.default.removeItem(at: temporary) }
    try data.write(to: temporary, options: .withoutOverwriting)
    let handle = try FileHandle(forWritingTo: temporary)
    defer { try? handle.close() }
    try handle.synchronize()
    try Task.checkCancellation()
    do {
      // Linking publishes a complete file atomically and refuses replacement.
      try FileManager.default.linkItem(at: temporary, to: target)
    } catch {
      guard FileManager.default.fileExists(atPath: target.path) else { throw error }
      // A concurrent publisher may have won with the same immutable bytes.
      try RemovalBridge.verifyAsset(name: name, data: Data(contentsOf: target))
    }
  }

  private func createDirectory() throws -> [URL] {
    // A synced child is not durable until the directory entry naming it is
    // also synced. Transfers may create several destination ancestors (#3940).
    var missing: [URL] = []
    var ancestor = directory
    while !FileManager.default.fileExists(atPath: ancestor.path) {
      missing.append(ancestor)
      ancestor = ancestor.deletingLastPathComponent()
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let parents = missing.map { $0.deletingLastPathComponent() }
    let carrier = [
      directory, directory.deletingLastPathComponent(), rawURL.deletingLastPathComponent(),
    ]
    return Set(carrier + parents).sorted { $0.pathComponents.count > $1.pathComponents.count }
  }

  private func syncDirectories(_ directories: [URL]) throws {
    for directory in directories {
      let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY)
      guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
      defer { close(descriptor) }
      guard fsync(descriptor) == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
      }
    }
  }
}
