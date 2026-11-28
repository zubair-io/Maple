import Foundation

/// Which sibling files are a photo's conflict copies (#6134). Pure name logic over a folder
/// listing, so the local and SMB engines list each folder once and ask as often as they need.
enum ConflictCopyPairing {
  private static let suffix = try? NSRegularExpression(
    pattern: "^" + FilenameVocabulary.pairedSidecarSuffixPattern + "$", options: .caseInsensitive)

  /// Conflict copies of `primaryName` in `siblings`. Another photo's own sidecar is excluded
  /// (`photo (conflict from Mac).xmp` beside `photo (conflict from Mac).dng`).
  static func names(in siblings: [String], primaryName: String, foldsCase: Bool) -> [String] {
    let stem = SidecarOwnership.stem(of: primaryName, foldsCase: foldsCase)
    return siblings.filter {
      isConflictCopy($0, ofStem: stem, foldsCase: foldsCase)
        && !isSidecarOfAnotherPhoto($0, among: siblings, besides: primaryName, foldsCase: foldsCase)
    }.sorted()
  }

  /// `stem` must already be a `SidecarOwnership.comparisonKey`; the vocabulary pattern also
  /// matches the canonical `.xmp`, which is not a conflict copy.
  static func isConflictCopy(_ name: String, ofStem stem: String, foldsCase: Bool) -> Bool {
    let key = SidecarOwnership.comparisonKey(name, foldsCase: foldsCase)
    guard key.hasPrefix(stem) else { return false }
    let tail = String(key.dropFirst(stem.count))
    return tail.lowercased() != ".xmp"
      && suffix?.firstMatch(in: tail, range: NSRange(tail.startIndex..<tail.endIndex, in: tail))
        != nil
  }

  /// A copy published under that name would become the other photo's edit.
  static func isSidecarOfAnotherPhoto(
    _ sidecarName: String, among siblings: [String], besides primaryName: String, foldsCase: Bool
  ) -> Bool {
    let key = { SidecarOwnership.comparisonKey($0, foldsCase: foldsCase) }
    return siblings.contains { name in
      SidecarOwnership.isPhotoName(name) && key(name) != key(primaryName)
        && key(SidecarPath.sidecarURL(for: URL(fileURLWithPath: name)).lastPathComponent)
          == key(sidecarName)
    }
  }
}
