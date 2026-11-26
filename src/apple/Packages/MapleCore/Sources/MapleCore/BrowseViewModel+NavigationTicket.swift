import Foundation

public struct BrowseNavigationTicket: Equatable, Sendable {
  fileprivate let navigation: UInt64
  fileprivate let generation: UInt64
}

extension BrowseViewModel {
  /// Marks a navigation that suspends before its load starts, such as a
  /// cloud folder waiting on sign-in or LAN discovery. A later ticket, or
  /// any load that starts on this model meanwhile, makes it stale. The load
  /// already running is left alone: it keeps the grid if this navigation
  /// never starts (sign-in dismissed).
  public func beginNavigation() -> BrowseNavigationTicket {
    pendingNavigation &+= 1
    return BrowseNavigationTicket(navigation: pendingNavigation, generation: loadGeneration)
  }

  public func isCurrent(_ ticket: BrowseNavigationTicket) -> Bool {
    ticket.navigation == pendingNavigation && ticket.generation == loadGeneration
  }
}
