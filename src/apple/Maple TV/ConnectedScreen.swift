// src/apple/Maple TV/ConnectedScreen.swift
import MapleCloudKit
import SwiftUI

/// Shown once a server is paired and holds valid tokens. Milestone C's
/// real deliverable — no placeholder — but deliberately thin: milestone D
/// replaces the body of this screen with the Timeline once that's built.
struct ConnectedScreen: View {
  let server: URL
  let onForgotten: () -> Void

  @State private var user: AuthUser?

  private var displayHost: String {
    CloudHost.parse(server.absoluteString)?.displayHost ?? server.host ?? server.absoluteString
  }

  private var displayName: String {
    CloudServerRegistry.shared.displayName(for: server) ?? displayHost
  }

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      VStack(spacing: 24) {
        Image(systemName: "checkmark.circle.fill")
          .font(.system(size: 64))
          .foregroundStyle(MapleTVTheme.primary)
          .accessibilityHidden(true)

        Text("Connected to \(displayName)")
          .font(.system(size: 40, weight: .semibold))
          .foregroundStyle(MapleTVTheme.textPrimary)
          .accessibilityLabel("Connected to \(displayName)")

        if let user {
          Text(user.email)
            .font(.system(size: 22))
            .foregroundStyle(MapleTVTheme.textMuted)
            .accessibilityLabel("Signed in as \(user.email)")
        }

        Button("Forget this server", role: .destructive) {
          forget()
        }
        .accessibilityLabel("Forget this server")
        .padding(.top, 24)
      }
      .padding(72)
    }
    .onAppear { user = AuthUserCache.load(server: server) }
  }

  private func forget() {
    // CloudServerRegistry.remove already clears TokenStore for this
    // server (see CloudServerRegistry.swift) — only the user-info cache
    // needs an explicit clear here.
    CloudServerRegistry.shared.remove(server)
    AuthUserCache.clear(server: server)
    onForgotten()
  }
}
