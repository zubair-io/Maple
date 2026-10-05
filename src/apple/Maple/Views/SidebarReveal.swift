// SidebarReveal.swift — shared helpers for sidebar folder expansion,
// row identification, and scroll reveal (Issue #4152).

import Foundation

enum SidebarReveal {
  /// True when `candidate` is an ancestor directory of `selectedPath`.
  static func isLocalAncestor(candidate: URL, selectedPath: String?) -> Bool {
    guard let selectedPath, selectedPath != candidate.path else { return false }
    let rootComponents = candidate.pathComponents
    let selectedComponents = URL(fileURLWithPath: selectedPath).pathComponents
    guard selectedComponents.count > rootComponents.count else { return false }
    return Array(selectedComponents.prefix(rootComponents.count)) == rootComponents
  }

  /// True when `candidatePath` is an ancestor directory of `currentPath` in a cloud library.
  static func isCloudAncestor(candidatePath: String, currentPath: String?) -> Bool {
    guard let current = currentPath, current != candidatePath else { return false }
    let prefix = candidatePath.hasSuffix("/") ? candidatePath : candidatePath + "/"
    return current.hasPrefix(prefix)
  }

  /// Generates a globally unique scroll/preference identifier for a cloud folder row,
  /// qualifying the relative path with the server's base URL to prevent collisions.
  static func cloudRowId(serverURL: URL, path: String) -> String {
    serverURL.absoluteString + path
  }

  /// Generates a unique scroll/preference identifier for an SMB share folder row.
  static func smbRowId(
    host: String, share: String, username: String? = nil, path: String, depth: Int
  ) -> String {
    let base: String
    if let username, !username.isEmpty {
      base = "smb:\(username)@\(host)/\(share)"
    } else {
      base = "smb:\(host)/\(share)"
    }
    if depth == 0 {
      return base
    }
    let normalizedPath = path.hasPrefix("/") ? path : "/" + path
    return base + normalizedPath
  }
}
