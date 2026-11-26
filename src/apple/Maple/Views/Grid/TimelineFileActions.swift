import CryptoKit
import Foundation
import MapleCore
import SwiftUI

/// Drag-out and Copy for Timeline tiles on macOS (#6002). A tile resolves to its
/// original only when a drag starts or Copy is chosen, so rendering a month
/// builds no sources and fetches nothing.
struct TimelineFileActions {
  let cloudAsset: @MainActor (SearchAsset, URL) -> AssetRef
  let localAsset: @MainActor (ImageRef) -> AssetRef?

  @MainActor
  func resolve(
    _ cell: MergedTimelineCell, absPathMap: [String: SearchAsset],
    server: @MainActor (SearchAsset) -> URL?
  ) -> [AssetRef] {
    switch CloudTimelineViewVM.selectionTarget(for: cell, absPathMap: absPathMap) {
    case .cloud(let asset): return server(asset).map { [cloudAsset(asset, $0)] } ?? []
    case .local(let ref): return localAsset(ref).map { [$0] } ?? []
    case .none: return []
    }
  }

  /// A tile's drag identity must stay stable across renders: SwiftUI keeps a
  /// cell's drag view, and its resolver, while the payload compares equal.
  static func tileID(_ key: String) -> UUID {
    let digest = Array(SHA256.hash(data: Data(key.utf8)))
    return UUID(
      uuid: (
        digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
        digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14],
        digest[15]
      ))
  }
}

extension PhotoGrid where Element == MergedTimelineCell {
  func timelineFileActions(
    _ actions: TimelineFileActions?, absPathMap: [String: SearchAsset],
    server: @escaping @MainActor (SearchAsset) -> URL?
  ) -> Self {
    #if os(macOS)
      guard let actions else { return self }
      var grid = self
      grid.dragPayload = { cell in
        DraggedAssetPayload(ids: [TimelineFileActions.tileID(MergedTimelineSource.renderID(cell))]) {
          actions.resolve(cell, absPathMap: absPathMap, server: server)
        }
      }
      grid.contextMenuItems = { cell in
        AnyView(
          CopyPhotosMenuItem(identifier: "timeline.copy.\(MergedTimelineSource.renderID(cell))") {
            actions.resolve(cell, absPathMap: absPathMap, server: server)
          })
      }
      return grid
    #else
      return self
    #endif
  }
}

extension PhotoGrid where Element == SearchAsset {
  func timelineFileActions(_ actions: TimelineFileActions?, server: URL) -> Self {
    #if os(macOS)
      guard let actions else { return self }
      var grid = self
      grid.dragPayload = { asset in
        DraggedAssetPayload(ids: [TimelineFileActions.tileID(asset.id)]) {
          [actions.cloudAsset(asset, server)]
        }
      }
      grid.contextMenuItems = { asset in
        AnyView(
          CopyPhotosMenuItem(identifier: "timeline.copy.\(asset.id)") {
            [actions.cloudAsset(asset, server)]
          })
      }
      return grid
    #else
      return self
    #endif
  }
}
