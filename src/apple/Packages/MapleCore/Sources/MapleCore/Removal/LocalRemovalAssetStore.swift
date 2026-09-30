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
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try publish(mask, names: names)
    try Task.checkCancellation()
    try publish(patch, names: names)
    try syncDirectory()
    // A previously accepted edit with missing assets must not disappear from
    // the proposed stack. Publication may leave safe orphans if this fails.
    _ = try readAssets(records: records)
    try Task.checkCancellation()
    return records
  }

  public func readAssets(records: String) throws -> [String: Data] {
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

  private func syncDirectory() throws {
    let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
  }
}
