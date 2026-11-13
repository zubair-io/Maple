import Foundation

/// The move/copy ask-flow's collision answers for one dropped tile (#5050). A stacked RAW+JPEG
/// tile is one tile but two files, so the user answers for each file whose name is taken, by that
/// file's name: Replace on the RAW's prompt never replaces the JPEG. Keep Both moves the pair to a
/// stem free for both files.
public struct StackCollisionAsk: Equatable, Sendable {
  /// The RAW's policy (or the only file's, for a tile without a stack).
  public private(set) var primary: CollisionPolicy = .fail
  /// The JPEG's own policy.
  public private(set) var companion: CollisionPolicy = .fail
  private let companionExtension: String?

  public init(stack: RawJpegStack?) {
    companionExtension = stack.map { ($0.companion.name as NSString).pathExtension.lowercased() }
  }

  /// Whether the collision at `path` is the JPEG's: its extension is the companion's.
  public func namesCompanion(_ path: String) -> Bool {
    guard let companionExtension else { return false }
    return (path as NSString).pathExtension.lowercased() == companionExtension
  }

  /// The name to put in the prompt for a collision at `path`, or nil when that file was already
  /// answered for and the retry collided again, which is a failure rather than a second question.
  public func promptName(for path: String, tileName: String) -> String? {
    guard primary != .autoSuffix else { return nil }
    if namesCompanion(path) {
      return companion == .fail ? (path as NSString).lastPathComponent : nil
    }
    return primary == .fail ? tileName : nil
  }

  /// Record the answer for the file at `path`. Returns false when the user skipped the tile.
  public mutating func answer(_ choice: AssetDropCollisionChoice, for path: String) -> Bool {
    switch choice {
    case .skip:
      return false
    case .keepBoth:
      primary = .autoSuffix
      companion = .fail
    case .replace:
      if namesCompanion(path) { companion = .replace } else { primary = .replace }
    }
    return true
  }
}
