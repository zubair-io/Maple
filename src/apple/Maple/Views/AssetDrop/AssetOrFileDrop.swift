import CoreTransferable
import MapleCore
import SwiftUI

/// Prefer internal selection identity when an outgoing drag also carries file URLs.
/// A single destination keeps a sidebar move from turning into a folder-open (#4632).
enum AssetOrFileDrop: Transferable {
  case selection(DraggedAssetPayload)
  case file(URL)

  static var transferRepresentation: some TransferRepresentation {
    ProxyRepresentation(importing: { (payload: DraggedAssetPayload) in Self.selection(payload) })
    ProxyRepresentation(importing: { (url: URL) in Self.file(url) })
  }

  static func assetIDs(in items: [Self]) -> Set<AssetRef.ID> {
    Set(
      items.flatMap { item in
        if case .selection(let payload) = item { return payload.ids }
        return []
      })
  }
}

extension View {
  func assetOrFileDropDestination(
    isTargeted: @escaping (Bool) -> Void,
    assets: @escaping (Set<AssetRef.ID>) -> Void,
    files: @escaping ([URL]) -> Bool
  ) -> some View {
    dropDestination(
      for: AssetOrFileDrop.self,
      action: { (items: [AssetOrFileDrop], _: CGPoint) -> Bool in
        let ids = AssetOrFileDrop.assetIDs(in: items)
        if !ids.isEmpty {
          assets(ids)
          return true
        }
        let urls = items.compactMap { item -> URL? in
          if case .file(let url) = item { return url }
          return nil
        }
        return !urls.isEmpty && files(urls)
      }, isTargeted: isTargeted)
  }
}
