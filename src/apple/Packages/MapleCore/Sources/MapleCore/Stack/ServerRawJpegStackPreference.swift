import Foundation
import MapleCloudKit

/// The 'Show one image for RAW+JPEG pairs' preference of each Self Hosted server (#5050): the
/// server keeps it as `stack_raw_jpeg` on `/api/display/config`, and stack-aware views (the Browse
/// grid, Timeline, search) read it here and then ask for folded results with `stack=1`. Nothing
/// else sends `stack=1`, so the File Provider and other file-syncing consumers keep both files.
public actor ServerRawJpegStackPreference {
  public static let shared = ServerRawJpegStackPreference()

  private var known: [String: Bool] = [:]

  public init() {}

  /// The preference for `server`, fetched once and then remembered. On when the server cannot be
  /// asked, which is the setting's default; a failed fetch is retried on the next call.
  public func isEnabled(
    server: URL, fetch: @Sendable () async throws -> DisplayConfig
  ) async -> Bool {
    if let value = known[server.absoluteString] { return value }
    guard let config = try? await fetch() else { return true }
    known[server.absoluteString] = config.stackRawJpeg
    return config.stackRawJpeg
  }

  /// Remember a value read or saved by Settings, so the next load uses it without asking again.
  public func record(_ value: Bool, server: URL) {
    known[server.absoluteString] = value
  }
}
