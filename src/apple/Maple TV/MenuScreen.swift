// src/apple/Maple TV/MenuScreen.swift
import SwiftUI

/// Which connected screen is showing. `menu` is the hub; the rest are the
/// content screens reached from it. Drives `RootTabView`.
enum RootScreen: String, Identifiable {
  case menu
  case timeline
  case lightTable
  case search

  var id: String { rawValue }
}

/// The connected hub. Replaces the old floating pill tab bar: the app
/// launches straight into the Timeline, the Siri Remote's Menu button (Back)
/// returns here from any content screen, and Back again from here backgrounds
/// the app (tvOS default — the menu attaches no `onExitCommand`). A plain
/// vertical list of focusable rows: the three content screens plus Log Out,
/// which unpairs this server (milestone C's `onForgotten`).
struct MenuScreen: View {
  let libraryName: String
  let onSelect: (RootScreen) -> Void
  let onForgotten: () -> Void

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 18) {
        Text(libraryName)
          .font(.system(size: 44, weight: .bold))
          .foregroundStyle(MapleTVTheme.textPrimary)
          .padding(.bottom, 16)
          .accessibilityAddTraits(.isHeader)

        MenuRow(title: "Timeline", systemImage: "photo.on.rectangle") { onSelect(.timeline) }
        MenuRow(title: "Light Table", systemImage: "rectangle.on.rectangle.angled") { onSelect(.lightTable) }
        MenuRow(title: "Search", systemImage: "magnifyingglass") { onSelect(.search) }
        MenuRow(title: "Log Out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
          onForgotten()
        }
      }
      .frame(maxWidth: 620)
    }
  }
}

/// One focusable menu row. The label lives in a child (`MenuRowCard`) so it
/// can read `\.isFocused` from the enclosing `Button` — the same split
/// `TimelineCell` uses.
private struct MenuRow: View {
  let title: String
  let systemImage: String
  var role: ButtonRole? = nil
  let action: () -> Void

  var body: some View {
    Button(role: role, action: action) {
      MenuRowCard(title: title, systemImage: systemImage, role: role)
    }
    .buttonStyle(.plain)
    // Our own fill + ring is the focus indication; suppress tvOS's default
    // focus halo (which is drawn wider than the row and looks broken here).
    .focusEffectDisabled()
    .accessibilityLabel(title)
  }
}

private struct MenuRowCard: View {
  let title: String
  let systemImage: String
  let role: ButtonRole?

  @Environment(\.isFocused) private var isFocused

  /// Dark text that reads on the focused white fill (matches the old pill
  /// bar's active-text `#141210`).
  private static let ink = Color(red: 0x14 / 255, green: 0x12 / 255, blue: 0x10 / 255)

  var body: some View {
    HStack(spacing: 22) {
      Image(systemName: systemImage)
        .font(.system(size: 28, weight: .medium))
        .frame(width: 40)
      Text(title)
        .font(.system(size: 30, weight: .semibold))
      Spacer(minLength: 0)
    }
    .foregroundStyle(foreground)
    .padding(.horizontal, 34)
    .padding(.vertical, 24)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(isFocused ? Color.white : Color.white.opacity(0.06))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .strokeBorder(MapleTVTheme.primary, lineWidth: isFocused ? 4 : 0)
    )
    .scaleEffect(isFocused ? 1.03 : 1.0)
    .animation(.easeOut(duration: 0.15), value: isFocused)
  }

  private var foreground: Color {
    if isFocused { return Self.ink }
    return role == .destructive ? MapleTVTheme.primary : MapleTVTheme.textPrimary
  }
}

#Preview {
  MenuScreen(libraryName: "Photos", onSelect: { _ in }, onForgotten: {})
    .preferredColorScheme(.dark)
}
