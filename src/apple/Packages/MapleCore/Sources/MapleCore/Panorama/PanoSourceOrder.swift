import Foundation

public enum PanoSourceOrder {
  public static func frames(_ assets: [AssetRef], onServer: Bool) -> [AssetRef] {
    if !onServer {
      return assets.sorted {
        ($0.primaryURL?.lastPathComponent ?? $0.displayName)
          < ($1.primaryURL?.lastPathComponent ?? $1.displayName)
      }
    }
    return assets.sorted {
      let lhs = ($0.catalog?.absPath ?? "").split(separator: "/")
      let rhs = ($1.catalog?.absPath ?? "").split(separator: "/")
      for (left, right) in zip(lhs, rhs) where left != right {
        return left.utf8.lexicographicallyPrecedes(right.utf8)
      }
      return lhs.count < rhs.count
    }
  }
}
