// DeepLinkRouter.swift — `maple://` URL-scheme router for the
// responsive-program deep-link spec.
//
// Two destinations land everything in v0.1:
//   • `maple://image/{id}` → Editor on that image
//   • `maple://source/{id}` → Library tab + source selected
//
// `MapleApp` registers `.onOpenURL { DeepLinkRouter.shared.handle($0) }`
// at the `WindowGroup` level. `AppShell` consumes the pending
// destination via `consume()` after `restoreLastSource()` completes
// (cold start) and also observes `pendingDestination` for warm-launch
// changes — the deep link always wins over restored state.
//
// Pure parsing lives in `MapleCore.DeepLinkParser` so `swift test` in
// the SPM package can cover it without booting the app bundle.
//
// Singleton: SwiftUI `.onOpenURL` is per-scene, and a single `App`
// process owns the URL queue. Multiple windows on macOS / iPad share
// one router; the focused window receives the consumption.
//
// Spec: docs/design/responsive-program/deep-links.md §3.
// Closes #624.

import Foundation
import MapleCore
import Observation

@MainActor
@Observable
final class DeepLinkRouter {
  static let shared = DeepLinkRouter()

  /// The destination most recently parsed from an incoming URL. Set by
  /// `handle(_:)`, cleared by `consume()`. Observable so the shell can
  /// react to warm-launch deliveries (cold start uses `consume()` from
  /// `.task` after `restoreLastSource()`).
  private(set) var pendingDestination: DeepLinkDestination?

  private init() {}

  #if DEBUG
    // App-hosted tests need independent queues, without exposing a production
    // constructor or consuming the shared router's real incoming documents.
    static func isolatedForTesting() -> DeepLinkRouter { DeepLinkRouter() }
  #endif

  /// Parse `url` and stash a destination if it matches the
  /// `maple://image/{id}` or `maple://source/{id}` shape. Unknown
  /// schemes / hosts / missing ids are silent no-ops — bad input
  /// never crashes, and the previously pending destination (if any)
  /// is preserved so we don't lose a delivery to a malformed link.
  func handle(_ url: URL) {
    if let destination = DeepLinkParser.parse(url) {
      pendingDestination = destination
    }
  }

  /// Atomically read + clear the pending destination. Returns `nil`
  /// when there's nothing queued. Idempotent — call sites use this
  /// as "did I get a deep link?" without coordinating with the URL
  /// delivery path.
  func consume(afterSourceRestore isReady: Bool) -> DeepLinkDestination? {
    // Warm-delivery observation also runs during cold-start awaits. A
    // premature consume loses the URL when restoration replaces the grid.
    guard isReady else { return nil }
    let dest = pendingDestination
    pendingDestination = nil
    return dest
  }
}
