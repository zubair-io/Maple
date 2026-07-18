// CloudHost.swift
//
// Parses a user-typed domain into a canonical URL.
//
// Accepted inputs (case-insensitive, trim whitespace):
//   "myserver.com"
//   "https://myserver.com"
//   "http://localhost:3000"
//   "myserver.com/"
// Rejected: empty, whitespace-only, anything with a path component beyond "/".

import Foundation

public struct CloudHost: Equatable, Sendable {
  public let url: URL

  public var displayHost: String {
    var s = url.host ?? url.absoluteString
    if let port = url.port { s += ":\(port)" }
    return s
  }

  public static func parse(_ raw: String) -> CloudHost? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else { return nil }

    let withScheme: String
    if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
      withScheme = trimmed
    } else {
      withScheme = "https://" + trimmed
    }

    let stripped = withScheme.hasSuffix("/") ? String(withScheme.dropLast()) : withScheme

    guard let url = URL(string: stripped),
          let host = url.host, !host.isEmpty,
          (url.path.isEmpty || url.path == "/")
    else { return nil }

    return CloudHost(url: url)
  }
}
