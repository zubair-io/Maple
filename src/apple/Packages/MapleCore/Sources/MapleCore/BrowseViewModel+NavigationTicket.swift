import Foundation

public struct BrowseNavigationTicket: Equatable, Sendable {
  fileprivate let generation: UInt64
}

extension BrowseViewModel {
  /// Claims the grid for a navigation that suspends before its load starts,
  /// such as a cloud folder waiting on sign-in or LAN discovery. Any later
  /// navigation on this model makes the ticket stale. A load it supersedes
  /// can no longer clear the spinner itself, so that happens here.
  public func beginNavigation() -> BrowseNavigationTicket {
    loadGeneration &+= 1
    if isLoading { isLoading = false }
    return BrowseNavigationTicket(generation: loadGeneration)
  }

  public func isCurrent(_ ticket: BrowseNavigationTicket) -> Bool {
    ticket.generation == loadGeneration
  }
}
