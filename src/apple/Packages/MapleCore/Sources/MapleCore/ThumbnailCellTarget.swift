// ThumbnailCellTarget.swift — which photo a reusable grid cell stands for, so
// a thumbnail refreshed in the background lands only on the cell still showing
// that photo.

@MainActor
public final class ThumbnailCellTarget {
  private var shownKey: String?

  public init() {}

  public func show(_ key: String) { shownKey = key }

  public func isShowing(_ key: String) -> Bool { shownKey == key }
}
