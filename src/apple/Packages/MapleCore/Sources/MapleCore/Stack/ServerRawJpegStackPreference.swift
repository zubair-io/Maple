import Foundation
import MapleCloudKit

/// The 'Show one image for RAW+JPEG pairs' preference of each Self Hosted server (#5050): the
/// server keeps it as `stack_raw_jpeg` on `/api/display/config`, and stack-aware views (the Browse
/// grid, Timeline, search) read it here and then ask for folded results with `stack=1`. Nothing
/// else sends `stack=1`, so the File Provider and other file-syncing consumers keep both files.
public actor ServerRawJpegStackPreference {
  public static let shared = ServerRawJpegStackPreference()

  private var known: [String: Bool] = [:]
  /// Per server: the newest save asked for (readable by tests), and the save the next one waits
  /// behind.
  private(set) var newestSave: [String: Int] = [:]
  private var lastSave: [String: Task<Void, Never>] = [:]

  public init() {}

  /// The preference for `server`, fetched once and then remembered. On when the server cannot be
  /// asked, which is the setting's default; a failed fetch is retried on the next call. A value
  /// Settings recorded or saved while the fetch was in flight is newer than its answer and wins.
  public func isEnabled(
    server: URL, fetch: @Sendable () async throws -> DisplayConfig
  ) async -> Bool {
    let key = server.absoluteString
    if let value = known[key] { return value }
    guard let config = try? await fetch() else { return known[key] ?? true }
    if let value = known[key] { return value }
    known[key] = config.stackRawJpeg
    return config.stackRawJpeg
  }

  /// A reader for one server's preference, for a stack-aware view's `CloudSearchClient` or
  /// listing: `identity` keys the preference (the registry URL Settings uses), `server` is where
  /// requests go (the LAN-resolved URL when one is active).
  public nonisolated static func reader(
    identity: URL, server: URL, httpClient: AuthenticatedHTTPClient
  ) -> @Sendable () async -> Bool {
    let client = DisplayConfigClient(server: server, httpClient: httpClient)
    return { await shared.isEnabled(server: identity) { try await client.fetch() } }
  }

  /// Remember a value read or saved by Settings, so the next load uses it without asking again.
  public func record(_ value: Bool, server: URL) {
    known[server.absoluteString] = value
  }

  /// Save `value` for `server` through `write` (the PUT), one save per server at a time: a save
  /// asked for while another is in flight waits for it, and one a newer save overtook while it
  /// waited is dropped, so a slow earlier request can never reach the server after a later one and
  /// the server keeps the last value asked for. A save that lands is remembered as `record` does.
  /// Returns false when a newer save overtook this one before it was sent.
  public func save(
    _ value: Bool, server: URL, write: @escaping @Sendable (Bool) async throws -> Void
  ) async throws -> Bool {
    let key = server.absoluteString
    let ticket = (newestSave[key] ?? 0) &+ 1
    newestSave[key] = ticket
    let previous = lastSave[key]
    let attempt = Task { () async -> Result<Bool, Error> in
      await previous?.value
      guard self.newestSave[key] == ticket else { return .success(false) }
      do {
        try await write(value)
      } catch {
        return .failure(error)
      }
      self.known[key] = value
      return .success(true)
    }
    lastSave[key] = Task { _ = await attempt.value }
    return try await attempt.value.get()
  }
}
