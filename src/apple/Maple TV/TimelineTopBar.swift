// src/apple/Maple TV/TimelineTopBar.swift
import SwiftUI

/// Persistent header above the Timeline grid: names which library/server
/// this TV is browsing, and keeps milestone C's "Forget this server"
/// pairing-reversal path reachable while the Timeline tab is active.
/// `RootTabView` (#2121) hosts the design's floating Timeline/Light-Table/
/// Search pill tab bar above this; the other two tabs have no top bar of
/// their own, so `RootTabView` supplies its own Forget affordance there
/// instead.
struct TimelineTopBar: View {
  let libraryName: String
  let serverDisplayName: String
  let onForgotten: () -> Void

  var body: some View {
    HStack(alignment: .center) {
      VStack(alignment: .leading, spacing: 4) {
        Text(libraryName)
          .font(.system(size: 28, weight: .semibold))
          .foregroundStyle(MapleTVTheme.textPrimary)
          .lineLimit(1)
        Text(serverDisplayName)
          .font(.system(size: 16))
          .foregroundStyle(MapleTVTheme.textMuted)
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("\(libraryName), on \(serverDisplayName)")

      Spacer()

      Button("Forget this server", role: .destructive, action: onForgotten)
        .accessibilityLabel("Forget this server")
        .accessibilityIdentifier("timeline-forget-server")
    }
    .padding(.horizontal, 72)
    .padding(.top, 48)
    .padding(.bottom, 24)
  }
}

#Preview {
  ZStack {
    MapleTVTheme.background.ignoresSafeArea()
    TimelineTopBar(libraryName: "My Photos", serverDisplayName: "maple.local", onForgotten: {})
  }
  .preferredColorScheme(.dark)
}
