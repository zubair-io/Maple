// URL+CacheKey.swift
//
// Single source of truth for "what string identifies a server in our
// caches?" — used as a directory segment in CloudBucketsCache,
// CloudPagesCache, CloudThumbCache, and as the in-memory key for
// related dicts.
//
// Plain `URL.host` drops the port, so e.g. http://localhost:3000 and
// http://localhost:3001 map to the same key — two dev servers would
// silently overwrite each other's cache entries. Including the port
// when it's present keeps them isolated.

import Foundation

extension URL {
  /// Cache-namespacing key for a server URL. `host` plus `:<port>` when
  /// a non-default port is present. Falls back to `absoluteString` if
  /// the URL has no host (shouldn't happen for cloud server URLs but
  /// keeps the function total).
  public var cacheHostKey: String {
    guard let h = host else { return absoluteString }
    if let p = port { return "\(h):\(p)" }
    return h
  }
}
