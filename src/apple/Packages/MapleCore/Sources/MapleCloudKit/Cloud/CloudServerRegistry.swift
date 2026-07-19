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

  /// Per-host user-supplied display name. Sidebar reads via
  /// `displayName(for:)`, which falls back to the URL host when a
  /// host has no override. Settings UI / rename context menu writes
  /// via `setDisplayName(_:for:)`.
  public private(set) var displayNames: [String: String]

  /// Per-host last-selected library id. Indexed by `URL.host`, same as
  /// `viewModes`/`displayNames`. Read by `TVCloudSession.resolveLibraries()`
  /// so a returning TV short-circuits straight to the remembered library
  /// instead of re-showing the picker on every launch.
  public private(set) var selectedLibraryIDs: [String: String]

  private static let listKey = "cloud.connectedServers"
  private let defaults: UserDefaults

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let loaded = Self.loadList(from: defaults)
    self.servers = loaded
    var modes: [String: CloudViewMode] = [:]
    var names: [String: String] = [:]
    var libraryIDs: [String: String] = [:]
    for url in loaded {
      if let host = url.host {
        modes[host] = CloudViewMode.load(host: host, defaults: defaults)
        if let name = defaults.string(forKey: Self.nameKey(host: host)),
           !name.isEmpty {
          names[host] = name
        }
        if let libraryID = defaults.string(forKey: Self.selectedLibraryIDKey(host: host)),
           !libraryID.isEmpty {
          libraryIDs[host] = libraryID
        }
      }
    }
    self.viewModes = modes
    self.displayNames = names
    self.selectedLibraryIDs = libraryIDs
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
      defaults.removeObject(forKey: Self.nameKey(host: host))
      defaults.removeObject(forKey: Self.selectedLibraryIDKey(host: host))
      viewModes[host] = nil
      displayNames[host] = nil
      selectedLibraryIDs[host] = nil
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

  /// User-supplied display name, or nil when no override exists.
  /// Callers should fall back to `url.host` for an unset name so the
  /// UI never shows an empty header.
  public func displayName(for url: URL) -> String? {
    guard let host = url.host else { return nil }
    return displayNames[host]
  }

  /// Set or clear the display name for a server. Pass nil (or an empty
  /// string after trimming) to remove the override and revert to the
  /// URL host fallback.
  public func setDisplayName(_ name: String?, for url: URL) {
    guard let host = url.host else { return }
    let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let value = trimmed, !value.isEmpty {
      displayNames[host] = value
      defaults.set(value, forKey: Self.nameKey(host: host))
    } else {
      displayNames[host] = nil
      defaults.removeObject(forKey: Self.nameKey(host: host))
    }
  }

  private static func nameKey(host: String) -> String {
    "cloud.\(host).displayName"
  }

  /// Last library id the user picked for this server (via a library
  /// picker, or an implicit single-library resolve), or nil when none has
  /// been chosen yet.
  public func selectedLibraryID(for url: URL) -> String? {
    guard let host = url.host else { return nil }
    return selectedLibraryIDs[host]
  }

  /// Set or clear the remembered library id for a server. Pass nil to
  /// forget the selection (e.g. the library was deleted server-side and a
  /// caller wants the picker to re-show).
  public func setSelectedLibraryID(_ libraryID: String?, for url: URL) {
    guard let host = url.host else { return }
    if let libraryID, !libraryID.isEmpty {
      selectedLibraryIDs[host] = libraryID
      defaults.set(libraryID, forKey: Self.selectedLibraryIDKey(host: host))
    } else {
      selectedLibraryIDs[host] = nil
      defaults.removeObject(forKey: Self.selectedLibraryIDKey(host: host))
    }
  }

  private static func selectedLibraryIDKey(host: String) -> String {
    "cloud.\(host).selectedLibraryID"
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
