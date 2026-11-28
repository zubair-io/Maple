import Foundation

/// The edit files besides the canonical sidecar that one local image or video owns: its UUID
/// workflow sidecars and its conflict copies (#6134). A foreign `.v2` sibling is deliberately
/// excluded, and case is significant on a volume that distinguishes filenames by case.
enum LocalPairedEditCopies {
  static func paired(with primary: URL) throws -> [URL] {
    let directory = primary.deletingLastPathComponent()
    return try paired(
      named: primary.lastPathComponent, in: directory, names: try listing(of: directory),
      foldsCase: SidecarOwnership.localVolumeFoldsCase(directory))
  }

  static func target(for sourceVariant: URL, from source: URL, to destination: URL) throws -> URL {
    URL(
      fileURLWithPath: try RestoreSidecarPairing.target(
        sourceVariant.path, from: source.path, to: destination.path))
  }

  /// A target stem already has a UUID branch or conflict copy, even if the photo itself does not
  /// exist. Only an identical copy from this source may join it (the second half of a RAW/JPEG
  /// pair); an unrelated one is a collision, and so is a name that is another photo's sidecar.
  /// A folder that cannot be listed is a failure, never "nothing there".
  static func occupied(at destination: URL, excluding source: URL) throws -> Bool {
    let own = try paired(with: source)
    let directory = destination.deletingLastPathComponent()
    let names = try listing(of: directory)
    let foldsCase = SidecarOwnership.localVolumeFoldsCase(directory)
    let heldByOther = try paired(
      named: destination.lastPathComponent, in: directory, names: names, foldsCase: foldsCase
    ).contains { candidate in
      !own.contains { variant in
        guard
          let target = try? target(for: variant, from: source, to: destination),
          SidecarOwnership.sameLocalFile(candidate.path, target.path)
        else { return false }
        return SidecarOwnership.sameLocalFile(candidate.path, variant.path)
          || SidecarOwnership.localSidecarAlreadyCarried(variant.path, at: candidate.path)
      }
    }
    return try heldByOther
      || own.contains { copy in
        ConflictCopyPairing.isSidecarOfAnotherPhoto(
          try target(for: copy, from: source, to: destination).lastPathComponent,
          among: names, besides: destination.lastPathComponent, foldsCase: foldsCase)
      }
  }

  private static func paired(
    named primaryName: String, in directory: URL, names: [String], foldsCase: Bool
  ) throws -> [URL] {
    let stem = SidecarPath.sidecarURL(for: URL(fileURLWithPath: primaryName))
      .deletingPathExtension().lastPathComponent
    let expression = try NSRegularExpression(
      pattern: "^" + NSRegularExpression.escapedPattern(for: stem) + "\\.v(?:"
        + WorkflowContract.uuidPattern + ")\\.xmp$",
      options: foldsCase ? [.caseInsensitive] : [])
    let variants = names.filter {
      expression.firstMatch(in: $0, range: NSRange($0.startIndex..<$0.endIndex, in: $0)) != nil
    }
    let conflictCopies = ConflictCopyPairing.names(
      in: names, primaryName: primaryName, foldsCase: foldsCase)
    return (variants + conflictCopies).sorted().map { directory.appendingPathComponent($0) }
  }

  private static func listing(of directory: URL) throws -> [String] {
    do {
      return try FileManager.default.contentsOfDirectory(atPath: directory.path)
    } catch {
      throw FileOperationError.underlying(
        "cannot list \(directory.path): \(error.localizedDescription)")
    }
  }
}
