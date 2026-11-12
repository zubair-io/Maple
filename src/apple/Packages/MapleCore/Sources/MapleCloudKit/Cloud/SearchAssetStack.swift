import Foundation

/// The JPEG folded into a RAW search or timeline hit when the server stacks RAW+JPEG pairs
/// (docs/api.md "RAW+JPEG stacks", #5849): the folder listing's companion fields plus the JPEG's
/// asset `id`, which a search hit always has. `address` is nil when the JPEG's library has no slug.
public struct SearchAssetStackCompanion: Codable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let address: String?
  public let path: String
  public let size: Int64
  public let mtime: String
  public let ext: String

  public init(
    id: String, name: String, address: String?, path: String, size: Int64, mtime: String,
    ext: String
  ) {
    self.id = id
    self.name = name
    self.address = address
    self.path = path
    self.size = size
    self.mtime = mtime
    self.ext = ext
  }
}

/// `SearchAsset.stack`: present on a RAW hit only, when the request folded RAW+JPEG stacks.
public struct SearchAssetStack: Codable, Equatable, Sendable {
  public let companion: SearchAssetStackCompanion

  public init(companion: SearchAssetStackCompanion) {
    self.companion = companion
  }
}
