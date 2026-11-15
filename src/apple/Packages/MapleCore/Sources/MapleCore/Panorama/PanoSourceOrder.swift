import Foundation

public enum PanoSourceOrder {
  public static func frames(_ assets: [AssetRef]) -> [AssetRef] {
    assets.sorted {
      ($0.primaryURL?.lastPathComponent ?? $0.displayName)
        < ($1.primaryURL?.lastPathComponent ?? $1.displayName)
    }
  }
}
