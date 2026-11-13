import Foundation

/// UUID workflow sidecars owned by one local image or video. A foreign `.v2`
/// sibling is deliberately excluded, and case is significant on a volume that
/// distinguishes filenames by case.
enum LocalWorkflowVariants {
  static func paired(with primary: URL) throws -> [URL] {
    let directory = primary.deletingLastPathComponent()
    let stem = SidecarPath.sidecarURL(for: primary).deletingPathExtension().lastPathComponent
    let pattern =
      "^" + NSRegularExpression.escapedPattern(for: stem)
      + "\\.v(?:" + WorkflowContract.uuidPattern + ")\\.xmp$"
    let options: NSRegularExpression.Options =
      SidecarOwnership.localVolumeFoldsCase(directory) ? [.caseInsensitive] : []
    let expression = try NSRegularExpression(pattern: pattern, options: options)
    return try FileManager.default.contentsOfDirectory(atPath: directory.path)
      .filter { name in
        expression.firstMatch(
          in: name, range: NSRange(name.startIndex..<name.endIndex, in: name)) != nil
      }
      .sorted()
      .map { directory.appendingPathComponent($0) }
  }

  static func target(for sourceVariant: URL, from source: URL, to destination: URL) throws -> URL {
    URL(
      fileURLWithPath: try RestoreSidecarPairing.target(
        sourceVariant.path, from: source.path, to: destination.path))
  }

  /// A target stem already has a UUID branch, even if the photo itself does
  /// not exist. Only an identical branch from this source may join it (the
  /// second half of a RAW/JPEG pair); an unrelated branch is a collision.
  static func occupied(at destination: URL, excluding source: URL) throws -> Bool {
    let own = try paired(with: source)
    return try paired(with: destination).contains { candidate in
      !own.contains { variant in
        guard
          let target = try? target(for: variant, from: source, to: destination),
          SidecarOwnership.sameLocalFile(candidate.path, target.path)
        else { return false }
        return SidecarOwnership.sameLocalFile(candidate.path, variant.path)
          || SidecarOwnership.localSidecarAlreadyCarried(variant.path, at: candidate.path)
      }
    }
  }
}
