import Foundation

/// Records which local original and canonical XMP produced a disposable derivative.
/// A sidecar can be removed or replaced externally without making the AVIF older
/// than the original, so comparing file mtimes alone cannot prove freshness.
enum LocalDerivativeSourceStamp {
  static func signature(for assetURL: URL) -> String {
    let original = fileStamp(at: assetURL)
    let sidecar = fileStamp(at: SidecarPath.sidecarURL(for: assetURL))
    return "source-v1|\(original)|\(sidecar)"
  }

  static func isFresh(_ derivativeURL: URL, for assetURL: URL) -> Bool {
    isFresh(derivativeURL, signature: signature(for: assetURL))
  }

  /// For a caller that already sampled the asset's signature, so a cache read
  /// stats the original and its XMP once instead of twice.
  static func isFresh(_ derivativeURL: URL, signature: String) -> Bool {
    guard let stored = try? String(contentsOf: stampURL(for: derivativeURL), encoding: .utf8)
    else { return false }
    return stored == signature
  }

  static func record(_ derivativeURL: URL, for assetURL: URL) {
    try? signature(for: assetURL).write(
      to: stampURL(for: derivativeURL), atomically: true, encoding: .utf8)
  }

  static func matches(_ expected: String, for assetURL: URL) -> Bool {
    signature(for: assetURL) == expected
  }

  static func record(_ derivativeURL: URL, sourceSignature: String) throws {
    try sourceSignature.write(
      to: stampURL(for: derivativeURL), atomically: true, encoding: .utf8)
  }

  static func remove(_ derivativeURL: URL) {
    try? FileManager.default.removeItem(at: stampURL(for: derivativeURL))
  }

  private static func stampURL(for derivativeURL: URL) -> URL {
    derivativeURL.appendingPathExtension("source")
  }

  private static func fileStamp(at url: URL) -> String {
    guard let stat = PlainFileStat.read(atPath: url.path) else { return "absent" }
    let modified = stat.modified.timeIntervalSinceReferenceDate.bitPattern
    return "\(stat.fileNumber):\(stat.size):\(modified)"
  }
}
