// src/apple/Maple TV/TabBar.swift
import SwiftUI

/// Which of `RootTabView`'s three tabs is active. `LightTable` is the
/// milestone F2 surface (`LightTableScreen`, #2121); `Search` is the
/// milestone E surface and still renders as a placeholder here;
/// `Timeline` is milestone D's grid, now hosted as one tab instead of the
/// whole connected root.
enum RootTab: String, CaseIterable, Identifiable {
  case timeline
  case lightTable
  case search

  var id: String { rawValue }

  var title: String {
    switch self {
    case .timeline: return "Timeline"
    case .lightTable: return "Light Table"
    case .search: return "Search"
    }
  }
}

/// The floating top-center pill tab bar (#2121 design: translucent
/// `rgba(255,255,255,.14)` capsule, active pill near-white with dark text,
/// inactive pills at reduced opacity). Each pill is a plain `Button`, so
/// the tvOS focus engine treats this row like any other focusable content
/// — moving focus up out of a tab's content lands here, and Select
/// switches `selectedTab`.
struct TabBar: View {
  @Binding var selectedTab: RootTab

  @FocusState private var focusedTab: RootTab?

  /// The pill design's active-state text color (`#141210`) — a near-black
  /// that reads correctly against the active pill's near-white fill,
  /// distinct from `MapleTVTheme.textPrimary` (which assumes a dark
  /// background) and not worth promoting into `MapleTVTheme` for a single
  /// caller (YAGNI).
  private static let activeText = Color(red: 0x14 / 255, green: 0x12 / 255, blue: 0x10 / 255)

  var body: some View {
    HStack(spacing: 8) {
      ForEach(RootTab.allCases) { tab in
        pill(for: tab)
      }
    }
    .padding(8)
    .background(
      Capsule(style: .continuous)
        .fill(Color.white.opacity(0.14))
    )
  }

  private func pill(for tab: RootTab) -> some View {
    let isSelected = tab == selectedTab
    let isFocused = tab == focusedTab
    return Button {
      selectedTab = tab
    } label: {
      Text(tab.title)
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(isSelected ? Self.activeText : MapleTVTheme.textPrimary)
        .opacity(isSelected ? 1.0 : 0.7)
        .padding(.horizontal, 28)
        .padding(.vertical, 14)
        .background(
          Capsule(style: .continuous)
            .fill(isSelected ? Color.white : Color.clear)
        )
        .overlay(
          Capsule(style: .continuous)
            .strokeBorder(MapleTVTheme.primary, lineWidth: isFocused ? 3 : 0)
        )
    }
    .buttonStyle(.plain)
    .focused($focusedTab, equals: tab)
    .accessibilityLabel("\(tab.title) tab")
    .accessibilityAddTraits(isSelected ? [.isSelected] : [])
  }
}

#Preview {
  ZStack {
    MapleTVTheme.background.ignoresSafeArea()
    TabBar(selectedTab: .constant(.timeline))
      .padding(.top, 48)
      .frame(maxWidth: .infinity, alignment: .center)
  }
  .preferredColorScheme(.dark)
}
