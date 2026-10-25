import Foundation

/// Records which local original and canonical XMP produced a disposable derivative.
/// A sidecar can be removed or replaced externally without making the AVIF older
/// than the original, so comparing file mtimes alone cannot prove freshness.
enum LocalDerivativeSourceStamp {
  static func signature(for assetURL: URL) -> String {
    let fileManager = FileManager.default
    let original = fileStamp(at: assetURL, fileManager: fileManager)
    let sidecar = fileStamp(at: SidecarPath.sidecarURL(for: assetURL), fileManager: fileManager)
    return "source-v1|\(original)|\(sidecar)"
  }

  static func isFresh(_ derivativeURL: URL, for assetURL: URL) -> Bool {
    guard let stored = try? String(contentsOf: stampURL(for: derivativeURL), encoding: .utf8)
    else { return false }
    return stored == signature(for: assetURL)
  }

  static func record(_ derivativeURL: URL, for assetURL: URL) {
    try? signature(for: assetURL).write(
      to: stampURL(for: derivativeURL), atomically: true, encoding: .utf8)
  }

  static func remove(_ derivativeURL: URL) {
    try? FileManager.default.removeItem(at: stampURL(for: derivativeURL))
  }

  private static func stampURL(for derivativeURL: URL) -> URL {
    derivativeURL.appendingPathExtension("source")
  }

  private static func fileStamp(at url: URL, fileManager: FileManager) -> String {
    guard let attributes = try? fileManager.attributesOfItem(atPath: url.path) else {
      return "absent"
    }
    let size = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
    let modified =
      (attributes[.modificationDate] as? Date)?
      .timeIntervalSinceReferenceDate.bitPattern ?? 0
    let fileNumber = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
    return "\(fileNumber):\(size):\(modified)"
  }
}
