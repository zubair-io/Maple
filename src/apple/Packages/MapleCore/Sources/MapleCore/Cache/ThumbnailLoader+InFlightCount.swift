import Foundation

extension ThumbnailLoader {
  /// Local thumbnail producers that have not finished; zero once the grid's
  /// visible cells have everything they asked for.
  public var inFlightLoadCount: Int { inFlight.count }
}
