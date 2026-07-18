// CloudViewMode.swift
//
// Per-server view-mode toggle. Persisted to UserDefaults under the key
// `cloud.<host>.viewMode`. Phase 2 wires Folder; Timeline lights up in Phase 3.

import Foundation

public enum CloudViewMode: String, Codable, Sendable, CaseIterable {
  case timeline
  case folder

  public static func load(host: String, defaults: UserDefaults = .standard) -> CloudViewMode {
    let key = "cloud.\(host).viewMode"
    if let raw = defaults.string(forKey: key), let mode = CloudViewMode(rawValue: raw) {
      return mode
    }
    return .folder
  }

  public func save(host: String, defaults: UserDefaults = .standard) {
    defaults.set(rawValue, forKey: "cloud.\(host).viewMode")
  }
}
