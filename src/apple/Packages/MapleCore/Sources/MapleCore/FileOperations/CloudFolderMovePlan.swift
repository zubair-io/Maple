import Foundation

/// Server paths are POSIX paths, independent of the Apple client's filesystem.
/// This plan validates both picker input and the path used to reopen a moved grid.
public struct CloudFolderMovePlan: Sendable, Equatable {
  public let sourcePath: String
  public let targetPath: String
  public let sourceRelativePath: String
  public let targetRelativePath: String
  public let isNoOp: Bool

  public init(root: String, source: String, destination: String) throws {
    let root = try Self.absolutePath(root)
    let source = try Self.absolutePath(source)
    let destination = try Self.absolutePath(destination)
    guard let sourceRelative = Self.relative(source, under: root), !sourceRelative.isEmpty,
      let destinationRelative = Self.relative(destination, under: root),
      Self.relative(destination, under: source) == nil,
      !sourceRelative.split(separator: "/").contains(where: { $0.hasPrefix(".") }),
      !destinationRelative.split(separator: "/").contains(where: { $0.hasPrefix(".") })
    else { throw FileOperationError.invalidDestination(destination) }
    let name = (source as NSString).lastPathComponent
    let target = Self.child(name, under: destination)
    self.sourcePath = source
    self.targetPath = target
    self.sourceRelativePath = sourceRelative
    self.targetRelativePath = destinationRelative.isEmpty ? name : destinationRelative + "/" + name
    self.isNoOp = target == source
  }

  /// A completion can repoint only the source subtree, not a sibling selected
  /// while the server request was in flight. The shell also checks server/library.
  public func reopenedPath(currentPath: String?) -> String? {
    guard let currentPath, let suffix = Self.relative(currentPath, under: sourcePath) else {
      return nil
    }
    return suffix.isEmpty ? targetPath : Self.child(suffix, under: targetPath)
  }

  static func child(_ name: String, under parent: String) -> String {
    parent == "/" ? "/" + name : parent + "/" + name
  }

  static func relative(_ path: String, under root: String) -> String? {
    if path == root { return "" }
    let prefix = root == "/" ? "/" : root + "/"
    return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : nil
  }

  static func absolutePath(_ path: String) throws -> String {
    let normalized = path == "/" ? path : path.trimmingSuffixSlashes
    let parts = normalized.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
    guard normalized.hasPrefix("/"), !normalized.contains("\0"),
      normalized == "/"
        || parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") })
    else { throw FileOperationError.invalidDestination(path) }
    return normalized
  }
}

extension String {
  fileprivate var trimmingSuffixSlashes: String {
    String(reversed().drop(while: { $0 == "/" }).reversed())
  }
}
