import Foundation

extension BrowseViewModel {
  /// Replace the checked set with the inclusive range in the current
  /// visible Browse order. A cleared or stale anchor starts a new selection
  /// at the clicked asset.
  @discardableResult
  public func selectRange(from anchor: AssetRef.ID?, to end: AssetRef.ID) -> AssetRef.ID? {
    guard isSelecting, let endIndex = assets.firstIndex(where: { $0.id == end }) else { return nil }
    let validAnchor = anchor.flatMap { id in
      selectedIDs.contains(id) ? assets.firstIndex(where: { $0.id == id }).map { (id, $0) } : nil
    }
    let anchorIndex = validAnchor?.1 ?? endIndex
    selectedIDs = Set(assets[min(anchorIndex, endIndex)...max(anchorIndex, endIndex)].map(\.id))
    return validAnchor?.0 ?? end
  }
}
