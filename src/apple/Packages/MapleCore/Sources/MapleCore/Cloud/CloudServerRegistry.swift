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

  /// Per-host view-mode mirror. Stored in-memory so SwiftUI Observation
  /// fires on `setViewMode`. UserDefaults is the persistence backend
  /// (write-through on every set) but observers track this dict.
  ///
  /// Indexed by `URL.host` (not by full URL) so that pre-existing
  /// per-host UserDefaults entries from before this map was introduced
  /// remain readable.
  public private(set) var viewModes: [String: CloudViewMode]

  private static let listKey = "cloud.connectedServers"
  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let loaded = Self.loadList(from: defaults)
    self.servers = loaded
    var modes: [String: CloudViewMode] = [:]
    for url in loaded {
      if let host = url.host {
        modes[host] = CloudViewMode.load(host: host, defaults: defaults)
      }
    }
    self.viewModes = modes
  }

  public func register(_ url: URL) {
    guard !servers.contains(url) else { return }
    servers.append(url)
    Self.saveList(servers, to: defaults)
    if let host = url.host, viewModes[host] == nil {
      viewModes[host] = CloudViewMode.load(host: host, defaults: defaults)
    }
  }

  public func remove(_ url: URL) {
    servers.removeAll { $0 == url }
    Self.saveList(servers, to: defaults)
    TokenStore.clear(server: url)
    if let host = url.host {
      defaults.removeObject(forKey: "cloud.\(host).viewMode")
      viewModes[host] = nil
    }
  }

  public func viewMode(for url: URL) -> CloudViewMode {
    guard let host = url.host else { return .folder }
    return viewModes[host] ?? .folder
  }

  public func setViewMode(_ mode: CloudViewMode, for url: URL) {
    guard let host = url.host else { return }
    // Mutating viewModes triggers Observation. The previous code
    // assigned `servers = servers` which `@Observable` correctly
    // treats as a no-op when the value is unchanged — so SwiftUI
    // never re-rendered and the toggle "worked" only via Picker's
    // own internal state.
    viewModes[host] = mode
    mode.save(host: host, defaults: defaults)
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
