import Foundation

/// The same persisted choices as the web Library grid's `cm.filter`.
public enum GridFilter: String, CaseIterable, Sendable {
  case all
  case picks
  case fourStars = "4stars"
  case edited

  public var title: String {
    switch self {
    case .all: "All"
    case .picks: "Picks"
    case .fourStars: "4+ stars"
    case .edited: "Edited"
    }
  }
}

/// Sidecar facts for one listed asset. A missing sidecar is represented by
/// default culling and `hasEdits == false`, not by an absent dictionary entry.
public struct GridFilterMetadata: Sendable {
  public let culling: CullingState
  public let hasEdits: Bool

  public init(culling: CullingState, hasEdits: Bool) {
    self.culling = culling
    self.hasEdits = hasEdits
  }
}
