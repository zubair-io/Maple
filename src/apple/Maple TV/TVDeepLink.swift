// src/apple/Maple TV/TVDeepLink.swift
//
// The `maple-tv://` links the Top Shelf hands back to the app.
//
// `TVTopShelfAction` carries a bare URL and nothing else, so this is the only
// channel between the Home-screen carousel and the running app. Parsing lives
// here, apart from the routing, so the URL grammar is one testable function
// rather than string handling spread through view code.

import Foundation
import MapleCloudKit
import Observation

/// Holds the link waiting to be acted on. An `@Observable` box rather than a
/// value passed down: the URL arrives at the `App` level, but the screens that
/// consume it (`RootTabView`, then `MemoriesScreen`) are several layers below
/// and only exist once a server and library have resolved — so the link has to
/// wait somewhere until they do.
@MainActor
@Observable
final class TVDeepLinkRouter {
  /// Cleared by whoever acts on it. Left set while the app is still reaching
  /// the screen that can honour it.
  var pending: TVDeepLink?

  func open(_ url: URL) {
    guard let link = TVDeepLink(url: url) else { return }
    pending = link
  }

  /// Take the pending memory id, if the pending link is one. Consuming it
  /// here means a link is honoured once and doesn't re-fire when the screen
  /// reloads its collections.
  func takePendingMemoryID() -> String? {
    let link = pending
    pending = nil
    guard case .memory(let id) = link else { return nil }
    return id
  }
}
