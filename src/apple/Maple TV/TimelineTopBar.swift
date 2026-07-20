// src/apple/Maple TV/TimelineTopBar.swift
import SwiftUI

/// Persistent header above the Timeline grid. Reflects the *focused* photo:
/// its short capture date is the title (e.g. "July 11, 2026") and its place,
/// when geocoded, is the subtitle (e.g. "Voorheesville, New York") — so the
/// timeline reads as one flat, newest-first wall of photos with the day and
/// location surfaced here instead of as in-grid section headers. Navigation
/// (Back to the Menu, Log Out) is handled by `RootTabView` / `MenuScreen`, so
/// this header carries no controls of its own.
struct TimelineTopBar: View {
  /// Focused photo's short date, or a neutral fallback (the library name)
  /// before any photo has focus / while the feed is still loading.
  let title: String
  /// Focused photo's place, when it has one — hidden entirely otherwise.
  let subtitle: String?

  var body: some View {
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
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
    // Cross-fade the header as focus moves between photos rather than
    // hard-cutting the date / place.
    .animation(.easeOut(duration: 0.15), value: title)
    .animation(.easeOut(duration: 0.15), value: subtitle)
    .padding(.horizontal, 72)
    .padding(.top, 48)
    .padding(.bottom, 24)
  }
}

#Preview {
  ZStack {
    MapleTVTheme.background.ignoresSafeArea()
    VStack(spacing: 40) {
      TimelineTopBar(title: "July 11, 2026", subtitle: "Voorheesville, New York")
      TimelineTopBar(title: "Photos", subtitle: nil)
    }
  }
  .preferredColorScheme(.dark)
}
