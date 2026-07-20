// src/apple/Maple TV/TimelineTopBar.swift
import SwiftUI

/// Persistent header above the Timeline grid. Reflects the *focused* photo:
/// its short capture date is the title (e.g. "July 11, 2026") and its place,
/// when geocoded, is the subtitle (e.g. "Voorheesville, New York") — so the
/// timeline reads as one flat, newest-first wall of photos with the day and
/// location surfaced here instead of as in-grid section headers. Also keeps
/// milestone C's "Forget this server" pairing-reversal path reachable while
/// the Timeline tab is active (the other two tabs get their own Forget
/// affordance from `RootTabView`).
struct TimelineTopBar: View {
  /// Focused photo's short date, or a neutral fallback ("Photos") before any
  /// photo has focus / while the feed is still loading.
  let title: String
  /// Focused photo's place, when it has one — hidden entirely otherwise.
  let subtitle: String?
  let onForgotten: () -> Void

  var body: some View {
    HStack(alignment: .center) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.system(size: 28, weight: .semibold))
          .foregroundStyle(MapleTVTheme.textPrimary)
          .lineLimit(1)
        if let subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(.system(size: 16))
            .foregroundStyle(MapleTVTheme.textMuted)
            .lineLimit(1)
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
      // Animate the header swap as focus moves between photos so the date /
      // place cross-fades rather than hard-cutting.
      .animation(.easeOut(duration: 0.15), value: title)
      .animation(.easeOut(duration: 0.15), value: subtitle)

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
    VStack(spacing: 40) {
      TimelineTopBar(title: "July 11, 2026", subtitle: "Voorheesville, New York", onForgotten: {})
      TimelineTopBar(title: "Photos", subtitle: nil, onForgotten: {})
    }
  }
  .preferredColorScheme(.dark)
}
