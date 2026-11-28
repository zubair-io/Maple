import Foundation
import OSLog

private let pairedCopyLog = Logger(
  subsystem: "app.justmaple.aperture", category: "LocalPairedEditCopies")

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
  /// So is a name that is one of this photo's own copies (a rename to its conflict copy's name):
  /// joining it as the new sidecar would let the cleanup remove it as a carried source.
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
    return try heldByOther || aliasesOwnCopy(own, from: source, to: destination)
      || own.contains { copy in
        ConflictCopyPairing.isSidecarOfAnotherPhoto(
          try target(for: copy, from: source, to: destination).lastPathComponent,
          among: names, besides: destination.lastPathComponent, foldsCase: foldsCase)
      }
  }

  private static func aliasesOwnCopy(_ own: [URL], from source: URL, to destination: URL) throws
    -> Bool
  {
    let canonical = SidecarPath.sidecarURL(for: destination)
    let landings = try own.map { try target(for: $0, from: source, to: destination) }
    return own.enumerated().contains { index, copy in
      SidecarOwnership.sameLocalFile(copy.path, canonical.path)
        || own.indices.contains {
          $0 != index && SidecarOwnership.sameLocalFile(own[$0].path, landings[index].path)
        }
    }
  }

  /// Removes the source edit copies a move has published. A conflict copy saved after it was
  /// staged (a sync tool's late write) is not what the destination holds, so it stays.
  static func removeCarried(_ plan: RelocatePlan) {
    let primaryName = (plan.sourcePrimaryPath as NSString).lastPathComponent
    let published =
      [plan.finalPrimaryPath] + [plan.finalSidecarPath].compactMap { $0 }
      + plan.finalVariantPaths
    for (source, destination) in zip(plan.sourceVariantPaths, plan.finalVariantPaths) {
      if published.contains(where: { SidecarOwnership.sameLocalFile($0, source) }) { continue }
      let foldsCase = SidecarOwnership.localVolumeFoldsCase(
        URL(fileURLWithPath: source).deletingLastPathComponent())
      let isConflictCopy = ConflictCopyPairing.isConflictCopy(
        (source as NSString).lastPathComponent,
        ofStem: SidecarOwnership.stem(of: primaryName, foldsCase: foldsCase), foldsCase: foldsCase)
      if isConflictCopy, !SidecarOwnership.localSidecarAlreadyCarried(source, at: destination) {
        pairedCopyLog.error("finalizeRelocate: changed conflict copy kept at source")
        continue
      }
      do {
        try FileManager.default.removeItem(atPath: source)
      } catch {
        pairedCopyLog.error(
          "finalizeRelocate: source edit copy unlink failed after a verified copy (\(source, privacy: .public)): \(error.localizedDescription, privacy: .public)"
        )
      }
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
