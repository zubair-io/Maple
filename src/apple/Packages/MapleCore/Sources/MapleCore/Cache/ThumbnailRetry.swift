// ThumbnailRetry.swift — how a visible cell recovers from an empty
// thumbnail (#5735).
//
// Grid and filmstrip cells load inside their own `.task`, which SwiftUI
// cancels when the cell leaves the screen. The retry runs inside that same
// task, so it costs nothing per scroll frame and stops the moment the cell
// disappears.

import Foundation

public enum ThumbnailRetry {
  /// Waits before each retry of a thumbnail rendered on this device: two
  /// more attempts over about 8 seconds. Few, because an asset that cannot
  /// be rendered repeats its whole render.
  public static let onDeviceDelays: [Duration] = [.seconds(2), .seconds(6)]

  /// Waits before each retry of a thumbnail a server renders: a growing
  /// backoff, then every 30 seconds for as long as the cell stays on screen.
  /// A server that is starting up or busy can refuse a whole first screen
  /// for longer than the on-device schedule lasts, and asking it again is
  /// one small request.
  public static var serverDelays: some Sequence<Duration> {
    (0...).lazy.map { serverRamp[min($0, serverRamp.count - 1)] }
  }

  private static let serverRamp: [Duration] = [
    .seconds(2), .seconds(6), .seconds(15), .seconds(30),
  ]

  /// `serverDelays` for an asset with no file on this device whose source
  /// answers thumbnails over the network, `onDeviceDelays` otherwise.
  public static func schedule(
    for asset: AssetRef, from source: (any ImageSource)?
  ) -> AnySequence<Duration> {
    schedule(rendersOnServer: asset.primaryURL == nil && source?.thumbnailsAreLatencyBound == true)
  }

  public static func schedule(for source: ThumbnailSource) -> AnySequence<Duration> {
    switch source {
    case .local(let asset, let box): schedule(for: asset, from: box?.source)
    case .cloud, .merged: schedule(rendersOnServer: true)
    case .photoKit: schedule(rendersOnServer: false)
    }
  }

  private static func schedule(rendersOnServer: Bool) -> AnySequence<Duration> {
    rendersOnServer ? AnySequence(serverDelays) : AnySequence(onDeviceDelays)
  }

  /// `attempt`'s result, retried after each delay while it comes back empty
  /// and the calling task has not been cancelled.
  public static func load<Value>(
    isolation: isolated (any Actor)? = #isolation,
    delays: some Sequence<Duration> = onDeviceDelays,
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
