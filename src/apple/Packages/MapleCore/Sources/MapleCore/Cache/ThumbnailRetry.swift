// ThumbnailRetry.swift — how a visible cell recovers from an empty
// thumbnail (#5735).
//
// Grid and filmstrip cells load inside their own `.task`, which SwiftUI
// cancels when the cell leaves the screen. The retry runs inside that same
// task, so it costs nothing per scroll frame and stops the moment the cell
// disappears; the schedule bounds it for a thumbnail that never exists.

import Foundation

public enum ThumbnailRetry {
  /// Waits before each retry: two more attempts over about 8 seconds. Few,
  /// because an asset that cannot be rendered repeats its whole render.
  public static let delays: [Duration] = [.seconds(2), .seconds(6)]

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
