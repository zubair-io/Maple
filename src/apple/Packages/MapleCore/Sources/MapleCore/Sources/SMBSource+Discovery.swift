// SMBSource+Discovery.swift — discovery filtering helpers for SMB assets (#4309).

import Foundation

extension SMBSource {
  /// True if any component of `fullPath` relative to `rootPath` begins with `.`.
  ///
  /// Excludes private staging directories (e.g. `.maple-copy.tmp.control`, `.maple`),
  /// hidden subfolders, and dotfiles from recursive library discovery, while
  /// preserving visible nested RAWs and permitting the source root itself to be a
  /// dot-prefixed directory (e.g. `/.vault/2026/img.dng`).
  public static func hasHiddenPathComponent(in fullPath: String, relativeTo rootPath: String)
    -> Bool
  {
    let rootComponents =
      rootPath
      .split(separator: "/", omittingEmptySubsequences: true)
      .map(String.init)
    let fullComponents =
      fullPath
      .split(separator: "/", omittingEmptySubsequences: true)
      .map(String.init)

    let relativeComponents: ArraySlice<String>
    if !rootComponents.isEmpty && fullComponents.starts(with: rootComponents) {
      relativeComponents = fullComponents.dropFirst(rootComponents.count)
    } else {
      relativeComponents = fullComponents[...]
    }

    return relativeComponents.contains { $0.hasPrefix(".") }
  }
}
