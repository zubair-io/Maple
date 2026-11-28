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
    return isFresh(stored: stored, signature: signature)
  }

  /// What a thumbnail read learned from its stamp: whether it is fresh, and the
  /// derivative's own size and modification time when this app recorded them.
  struct Reading {
    let isFresh: Bool
    let ownWrite: String?

    static let stale = Reading(isFresh: false, ownWrite: nil)
  }

  static func read(_ derivativeURL: URL, signature: String) -> Reading {
    guard let stored = try? String(contentsOf: stampURL(for: derivativeURL), encoding: .utf8),
      isFresh(stored: stored, signature: signature)
    else { return .stale }
    let proof = stored.dropFirst(signature.count).dropFirst(ownWriteMarker.count)
    return Reading(isFresh: true, ownWrite: stored == signature ? nil : String(proof))
  }

  /// True when the derivative still has the size and modification time its
  /// writer recorded. Call after reading the bytes, so a replacement that lands
  /// between the read and the stat can only make the file look unproven.
  static func fileMatches(_ ownWrite: String, at derivativeURL: URL) -> Bool {
    ownWrite == ownWriteStamp(at: derivativeURL)
  }

  static func recordOwnWrite(_ derivativeURL: URL, for assetURL: URL) {
    try? recordOwnWrite(derivativeURL, sourceSignature: signature(for: assetURL))
  }

  /// For a derivative this app has just written atomically from its own encoder.
  static func recordOwnWrite(_ derivativeURL: URL, sourceSignature: String) throws {
    guard let ownWrite = ownWriteStamp(at: derivativeURL) else {
      return try record(derivativeURL, sourceSignature: sourceSignature)
    }
    try (sourceSignature + ownWriteMarker + ownWrite).write(
      to: stampURL(for: derivativeURL), atomically: true, encoding: .utf8)
  }

  private static let ownWriteMarker = "|own:"

  private static func isFresh(stored: String, signature: String) -> Bool {
    stored == signature || stored.hasPrefix(signature + ownWriteMarker)
  }

  private static func ownWriteStamp(at derivativeURL: URL) -> String? {
    PlainFileStat.read(atPath: derivativeURL.path).map {
      "\($0.size):\($0.modified.timeIntervalSinceReferenceDate.bitPattern)"
    }
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
