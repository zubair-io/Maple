import CoreTransferable
import Foundation
import UniformTypeIdentifiers

extension UTType {
  /// Internal selection identity; never advertise asset UUIDs as public text (#4632).
  public static let mapleAssetSelection = UTType(
    exportedAs: "app.justmaple.asset-selection", conformingTo: .data)
}

/// Internal move/copy identity, with lazy original resolution for outgoing file drags.
public struct DraggedAssetPayload: Transferable, Equatable, Sendable {
  public let ids: [AssetRef.ID]
  /// Resolve only when dragging starts, avoiding a library scan per visible tile.
  public let resolveAssets: (@MainActor @Sendable () -> [AssetRef])?

  public init(
    ids: [AssetRef.ID], resolveAssets: (@MainActor @Sendable () -> [AssetRef])? = nil
  ) {
    self.ids = ids
    self.resolveAssets = resolveAssets
  }

  public static func == (lhs: Self, rhs: Self) -> Bool { lhs.ids == rhs.ids }

  public static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(contentType: .mapleAssetSelection) { payload in
      Data(payload.encoded.utf8)
    } importing: { data in
      DraggedAssetPayload(encoded: String(decoding: data, as: UTF8.self))
    }
  }

  var encoded: String { ids.map(\.uuidString).joined(separator: ",") }

  init(encoded: String) {
    self.init(ids: encoded.split(separator: ",").compactMap { UUID(uuidString: String($0)) })
  }

  public var previewBadgeText: String { Self.previewBadgeText(forCount: ids.count) }

  public static func previewBadgeText(forCount count: Int) -> String {
    count == 1 ? "1 Photo" : "\(count) Photos"
  }
}
