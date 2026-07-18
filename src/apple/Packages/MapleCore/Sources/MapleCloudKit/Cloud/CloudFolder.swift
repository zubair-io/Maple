// CloudFolder.swift
//
// DTO for `GET /api/folders` — one entry per registered filesystem
// folder on the Maple Cloud server. The user's "library" concept maps
// to one of these entries; multiple libraries per server is fine.

import Foundation

public struct CloudFolder: Codable, Equatable, Sendable, Identifiable {
  public let id: String
  public let path: String
  public let label: String
  public let last_scan: String?
  public let file_count: Int
  public let created_at: String

  public init(id: String, path: String, label: String,
              last_scan: String? = nil, file_count: Int = 0,
              created_at: String = "") {
    self.id = id
    self.path = path
    self.label = label
    self.last_scan = last_scan
    self.file_count = file_count
    self.created_at = created_at
  }

  /// User-facing label — server-side `label` if non-empty, else last
  /// path segment.
  public var displayName: String {
    if !label.isEmpty { return label }
    return (path as NSString).lastPathComponent
  }
}
