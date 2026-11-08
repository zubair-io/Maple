// ThumbnailRetry.swift — how a visible cell recovers from an empty
// thumbnail (#5735).
//
// Grid and filmstrip cells load inside their own `.task`, which SwiftUI
// cancels when the cell leaves the screen. An empty answer (a cancelled
// shared fetch, a server still indexing, a dropped connection) used to
// leave the cell grey until scrolling re-created it. The retry runs inside
// that same task, so it costs nothing per scroll frame and stops the moment
// the cell disappears; the schedule bounds it for a thumbnail that never
// exists.

import Foundation

public enum ThumbnailRetry {
  /// Waits before each retry: three more attempts over about 13 seconds.
  public static let delays: [Duration] = [.seconds(1), .seconds(3), .seconds(9)]

  /// `attempt`'s result, retried after each delay while it comes back empty
  /// and the calling task has not been cancelled.
  public static func load<Value>(
    isolation: isolated (any Actor)? = #isolation,
    delays: [Duration] = delays,
    sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
    _ attempt: () async -> Value?
  ) async -> Value? {
    if let value = await attempt() { return value }
    for delay in delays {
      do { try await sleep(delay) } catch { return nil }
      guard !Task.isCancelled else { return nil }
      if let value = await attempt() { return value }
    }
    return nil
  }
}
