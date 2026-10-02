import Foundation

/// Complete logical destination tree inside one registered library (#4017).
/// Canonical paths exclude aliases into the source subtree and stop ancestor
/// cycles; links to other safe directories remain selectable destinations.
public enum CloudFolderMoveDestinations {
  public static func tree(
    root: String, rootName: String, excluding source: String, client: CloudFoldersClient
  ) async throws -> [FolderMoveDestination] {
    let root = try CloudFolderMovePlan.absolutePath(root)
    let source = try CloudFolderMovePlan.absolutePath(source)
    _ = try CloudFolderMovePlan(root: root, source: source, destination: root)
    try Task.checkCancellation()
    let sourceListing = try await client.listDir(absPath: source)
    let rootListing = try await client.listDir(absPath: root)
    let physicalRoot = try physicalPath(rootListing, expected: root)
    let physicalSource = try physicalPath(sourceListing, expected: source)
    guard CloudFolderMovePlan.relative(physicalSource, under: physicalRoot) != nil,
      physicalSource != physicalRoot
    else { throw FileOperationError.invalidDestination(source) }
    return try await subtree(
      rootListing, name: rootName, parent: nil, depth: 0, ancestors: [],
      root: root, physicalRoot: physicalRoot, source: source, physicalSource: physicalSource,
      client: client)
  }

  private static func physicalPath(_ listing: FsDirListing, expected: String) throws -> String {
    guard listing.path == expected, let physical = listing.realPath else {
      throw FileOperationError.underlying(
        "Cannot load move destinations. The folder is unavailable or the server needs an update.")
    }
    return try CloudFolderMovePlan.absolutePath(physical)
  }

  private static func subtree(
    _ listing: FsDirListing, name: String, parent: String?, depth: Int, ancestors: Set<String>,
    root: String, physicalRoot: String, source: String, physicalSource: String,
    client: CloudFoldersClient
  ) async throws -> [FolderMoveDestination] {
    try Task.checkCancellation()
    let path = listing.path
    let physical = try physicalPath(listing, expected: path)
    // A link to an ancestor is a valid destination but cannot be expanded forever.
    if ancestors.contains(physical) {
      return [
        FolderMoveDestination(
          id: path, parentID: parent, name: name, depth: depth, hasChildren: false)
      ]
    }
    let children = try listing.dirs.filter { !$0.name.hasPrefix(".") }.sorted { $0.name < $1.name }
      .filter { child in
        guard !child.name.isEmpty, !child.name.contains("/"), !child.name.contains("\\"),
          child.path == CloudFolderMovePlan.child(child.name, under: path),
          CloudFolderMovePlan.relative(child.path, under: root) != nil,
          let real = child.realPath,
          CloudFolderMovePlan.relative(real, under: physicalRoot) != nil
        else { throw FileOperationError.invalidDestination(child.path) }
        return CloudFolderMovePlan.relative(child.path, under: source) == nil
          && CloudFolderMovePlan.relative(real, under: physicalSource) == nil
      }
    guard Set(children.map(\.path)).count == children.count else {
      throw FileOperationError.underlying(
        "The folder listing contains duplicate destinations. Try again.")
    }
    let node = FolderMoveDestination(
      id: path, parentID: parent, name: name, depth: depth, hasChildren: !children.isEmpty)
    let nextAncestors = ancestors.union([physical])
    var descendants: [FolderMoveDestination] = []
    for child in children {
      try Task.checkCancellation()
      let childListing = try await client.listDir(absPath: child.path)
      guard try physicalPath(childListing, expected: child.path) == child.realPath else {
        throw FileOperationError.underlying(
          "The folder changed while loading destinations. Try again.")
      }
      descendants += try await subtree(
        childListing, name: child.name, parent: path, depth: depth + 1, ancestors: nextAncestors,
        root: root, physicalRoot: physicalRoot, source: source, physicalSource: physicalSource,
        client: client)
    }
    try Task.checkCancellation()
    return [node] + descendants
  }
}
