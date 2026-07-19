// src/apple/Maple TV/SearchTabPlaceholder.swift
import SwiftUI

/// Temporary empty state for `RootTabView`'s Search tab (#2121). Milestone
/// E builds natural-language photo search here; until then this keeps the
/// tab reachable and clearly labeled as not-yet-built rather than a dead
/// end or a placeholder that reads like a bug.
struct SearchTabPlaceholder: View {
  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      VStack(spacing: 16) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 56))
          .foregroundStyle(MapleTVTheme.textMuted)
          .accessibilityHidden(true)
        Text("Search")
          .font(.system(size: 32, weight: .semibold))
          .foregroundStyle(MapleTVTheme.textPrimary)
        Text("Coming in milestone E")
          .font(.system(size: 20))
          .foregroundStyle(MapleTVTheme.textMuted)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Search — coming in milestone E")
    }
  }
}

#Preview {
  SearchTabPlaceholder()
}
