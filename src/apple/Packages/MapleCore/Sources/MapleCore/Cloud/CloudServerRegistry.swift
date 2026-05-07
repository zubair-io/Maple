// CloudServerRegistry.swift
//
// Singleton @Observable that owns the list of connected Maple Cloud servers
// and per-server settings. The sidebar reads `servers` to render its
// CloudServerSection rows; each section reads `viewMode(for:)` to render
// its toggle. Connected servers persist to UserDefaults under
// `cloud.connectedServers`; per-server modes persist via CloudViewMode.

import Foundation
import Observation

@MainActor
@Observable
public final class CloudServerRegistry {
  /// Singleton — Apple uses this from the sidebar and from the
  /// AddMapleCloud onSignedIn callback.
  public static let shared = CloudServerRegistry()

  /// Currently-connected servers, in registration order.
  public private(set) var servers: [URL]

  private static let listKey = "cloud.connectedServers"
  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    self.servers = Self.loadList(from: defaults)
  }

  public func register(_ url: URL) {
    guard !servers.contains(url) else { return }
    servers.append(url)
    Self.saveList(servers, to: defaults)
  }

  public func remove(_ url: URL) {
    servers.removeAll { $0 == url }
    Self.saveList(servers, to: defaults)
    TokenStore.clear(server: url)
    if let host = url.host {
      defaults.removeObject(forKey: "cloud.\(host).viewMode")
    }
  }

  public func viewMode(for url: URL) -> CloudViewMode {
    guard let host = url.host else { return .folder }
    return CloudViewMode.load(host: host, defaults: defaults)
  }

  public func setViewMode(_ mode: CloudViewMode, for url: URL) {
    guard let host = url.host else { return }
    mode.save(host: host, defaults: defaults)
    // Trigger Observation-tracked invalidation by re-assigning servers.
    servers = servers
  }

  // MARK: - Persistence

  private static func loadList(from defaults: UserDefaults) -> [URL] {
    guard let data = defaults.data(forKey: listKey),
          let strings = try? JSONDecoder().decode([String].self, from: data)
    else { return [] }
    return strings.compactMap { URL(string: $0) }
  }

  private static func saveList(_ servers: [URL], to defaults: UserDefaults) {
    let strings = servers.map { $0.absoluteString }
    if let data = try? JSONEncoder().encode(strings) {
      defaults.set(data, forKey: listKey)
    }
  }
}
