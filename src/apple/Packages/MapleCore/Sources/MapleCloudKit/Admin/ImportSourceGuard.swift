// ImportSourceGuard.swift — client-side mirror of the server's "source
// can't be inside the target library" check (#2773).
//
// Convenience only. The server jails and realpath-resolves the source, then
// re-checks it against the LIBRARY'S realpath (`isInsideLibrary` in
// `src/api/src/routes/imports.ts`) before ever touching the filesystem for
// a create — a client-side pass here can only steer the picker away from an
// obviously-bad choice, never replace that check.
//
// Deliberately asymmetric: rejects the library itself and anything inside
// it, but allows ancestors (e.g. `/`). Blocking ancestors too would flag
// every folder on the way down from the filesystem root, and a parent of
// the library is a perfectly fine place to import loose files from — the
// library's own files just dedup-skip during the copy.

import Foundation

public enum ImportSourceGuard {
  public static func isInsideLibrary(source: String, library: String) -> Bool {
    let s = normalized(source)
    let l = normalized(library)
    if s == l { return true }
    let libraryPrefix = l == "/" ? "/" : l + "/"
    return s.hasPrefix(libraryPrefix)
  }

  /// Strips trailing slashes, falling back to `/` for an all-slashes (or
  /// empty) input — mirrors the web/server's
  /// `path.replace(/\/+$/, '') || '/'`.
  private static func normalized(_ path: String) -> String {
    var trimmed = path
    while trimmed.count > 1, trimmed.hasSuffix("/") {
      trimmed.removeLast()
    }
    return trimmed.isEmpty ? "/" : trimmed
  }
}
