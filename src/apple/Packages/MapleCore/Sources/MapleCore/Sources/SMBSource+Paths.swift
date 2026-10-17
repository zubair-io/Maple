import Foundation

extension SMBSource {
  /// Listed locations keep identical RAW copies' sidecars independent (#4085).
  /// Relocations retain captured references, including across reconnects.
  /// ID lookup remains a fallback for reads and decodes of legacy references
  /// without a location; mutations go through `mutationPath(for:)` instead.
  func path(for ref: ImageRef) -> String {
    relocatedPaths[ref] ?? ref.smbPath ?? pathByMapleId[ref.id] ?? ref.id
  }

  /// The one file a rename, move, trash or sidecar write may touch. A
  /// location-less reference whose content id was listed at several paths
  /// would otherwise resolve to whichever copy was listed last (#4705).
  func mutationPath(for ref: ImageRef) throws -> String {
    if let located = relocatedPaths[ref] ?? ref.smbPath { return located }
    guard !ambiguousMapleIds.contains(ref.id) else {
      throw SMBError.ambiguousLocation(ref.displayName)
    }
    return pathByMapleId[ref.id] ?? ref.id
  }
}
