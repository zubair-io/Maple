import Foundation

extension SMBSource {
  /// Listed locations keep identical RAW copies' sidecars independent (#4085).
  /// Relocations retain captured references, including across reconnects,
  /// until a fresh listing finds a file at the reference's old path again.
  /// ID lookup remains a fallback for reads and decodes of legacy references
  /// without a location; mutations go through `mutationPath(for:)` instead.
  func path(for ref: ImageRef) -> String {
    relocatedPaths[ref] ?? ref.smbPath ?? pathByMapleId[ref.id] ?? ref.id
  }

  /// The one file a rename, move, trash or sidecar write may touch. A
  /// location-less reference whose content id was listed at several paths
  /// would otherwise resolve to whichever copy was listed last (#4705).
  func mutationPath(for ref: ImageRef) throws -> String {
    // A path names a file only on the share that listed it; the app opens one source per
    // share, so a ref from another source may name a stranger at the same path (#4987).
    guard ref.smbSourceID == nil || ref.smbSourceID == listingID else {
      throw SMBError.foreignShare(ref.displayName)
    }
    if let located = relocatedPaths[ref] ?? ref.smbPath { return located }
    guard !ambiguousMapleIds.contains(ref.id) else {
      throw SMBError.ambiguousLocation(ref.displayName)
    }
    return pathByMapleId[ref.id] ?? ref.id
  }
}
