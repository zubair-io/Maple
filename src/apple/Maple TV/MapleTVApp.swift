// src/apple/Maple TV/MapleTVApp.swift
import MapleCloudKit
import Observation
import SwiftUI

@main
struct MapleTVApp: App {
  var body: some Scene {
    WindowGroup {
      RootView()
    }
  }
}

/// Chooses between the pairing flow and the connected screen. A server
/// counts as "connected" only when it's both registered AND has a
/// persisted token pair in the Keychain — a registered server whose
/// pairing never finished (or whose tokens were cleared) still routes to
/// `PairingScreen`, not a half-connected state.
private struct RootView: View {
  @State private var state = TVRootState()

  var body: some View {
    Group {
      if let server = state.connectedServer {
        ConnectedScreen(server: server, onForgotten: { state.refresh() })
      } else {
        PairingScreen(onPaired: { state.refresh() })
      }
    }
    .preferredColorScheme(.dark)
  }
}

@MainActor
@Observable
private final class TVRootState {
  private(set) var connectedServer: URL?

  init() {
    connectedServer = Self.firstConnectedServer()
  }

  func refresh() {
    connectedServer = Self.firstConnectedServer()
  }

  private static func firstConnectedServer() -> URL? {
    CloudServerRegistry.shared.servers.first { hasStoredTokens(for: $0) }
  }

  /// `try?` on a throwing function returning `AuthTokens?` flattens to a
  /// single `AuthTokens?` (Swift 5+, SE-0230) — both "load threw" and
  /// "load succeeded with no stored item" collapse to `nil`, which is
  /// exactly the "no usable tokens" signal this needs.
  private static func hasStoredTokens(for server: URL) -> Bool {
    (try? TokenStore.load(server: server)) != nil
  }
}
