// src/apple/Maple TV/RootTabView.swift
import MapleCloudKit
import SwiftUI

/// Connected root once a library is selected (#2121). `ConnectedScreen`
/// presents this — instead of `TimelineScreen` directly — as soon as
/// `session.selectedLibraryID` resolves, whether that came from an
/// implicit `.one` auto-select or a `LibraryPickerScreen` tap. Hosts the
/// floating Timeline / Light Table / Search pill `TabBar` from the design
/// and switches content beneath it; `TimelineScreen` itself is unchanged,
/// just now one of three tabs instead of the whole screen.
///
/// Light Table (F2) and Search (milestone E) are placeholders here — see
/// `LightTablePlaceholder` below and `SearchTabPlaceholder.swift`.
struct RootTabView: View {
  let session: TVCloudSession
  let libraryID: String
  let libraryName: String
  let onForgotten: () -> Void

  @State private var selectedTab: RootTab = .timeline

  var body: some View {
    ZStack(alignment: .top) {
      content

      TabBar(selectedTab: $selectedTab)
        .padding(.top, 48)
        .frame(maxWidth: .infinity, alignment: .center)

      // `TimelineTopBar` already carries its own "Forget this server"
      // control (top-trailing) for the Timeline tab — this chrome-level
      // one only renders for the other two tabs, which have no top bar of
      // their own, so the pairing-reversal path (milestone C) stays
      // reachable from every tab without stacking two Forget buttons on
      // top of each other when Timeline is active.
      if selectedTab != .timeline {
        forgetButton
          .frame(maxWidth: .infinity, alignment: .trailing)
          .padding(.top, 48)
          .padding(.trailing, 72)
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    switch selectedTab {
    case .timeline:
      TimelineScreen(
        session: session,
        libraryID: libraryID,
        libraryName: libraryName,
        onForgotten: onForgotten
      )
    case .lightTable:
      LightTablePlaceholder()
    case .search:
      SearchTabPlaceholder()
    }
  }

  private var forgetButton: some View {
    Button("Forget this server", role: .destructive, action: onForgotten)
      .accessibilityLabel("Forget this server")
  }
}

/// Temporary empty state for the Light Table tab (#2121). F2 replaces
/// this with the real Light Table (`CloudSearchClient`-backed comparison
/// grid); kept inline (not its own file) since the brief scopes this
/// task's new files to `RootTabView.swift`, `TabBar.swift`, and
/// `SearchTabPlaceholder.swift`.
///
/// Unlike the app's other screens, the Light Table's background is the
/// design's warm paper gradient (`#fdfcf9` → `#e6e1d5`) rather than
/// `MapleTVTheme.background` — a deliberate light surface distinct from
/// the dark Timeline/Search chrome, so this placeholder already renders
/// on the correct background rather than F2 needing to swap it later.
private struct LightTablePlaceholder: View {
  private static let paperTop = Color(red: 0xfd / 255, green: 0xfc / 255, blue: 0xf9 / 255)
  private static let paperBottom = Color(red: 0xe6 / 255, green: 0xe1 / 255, blue: 0xd5 / 255)
  private static let ink = Color(red: 0x1c / 255, green: 0x19 / 255, blue: 0x17 / 255)

  var body: some View {
    ZStack {
      LinearGradient(colors: [Self.paperTop, Self.paperBottom], startPoint: .top, endPoint: .bottom)
        .ignoresSafeArea()

      VStack(spacing: 16) {
        Image(systemName: "rectangle.grid.2x2")
          .font(.system(size: 56))
          .foregroundStyle(Self.ink.opacity(0.4))
          .accessibilityHidden(true)
        Text("Light Table")
          .font(.system(size: 32, weight: .semibold))
          .foregroundStyle(Self.ink)
        Text("Coming in F2")
          .font(.system(size: 20))
          .foregroundStyle(Self.ink.opacity(0.6))
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Light Table — coming in F2")
    }
  }
}

#Preview {
  RootTabView(
    session: TVCloudSession(server: URL(string: "https://maple.local")!, onSignOut: {}),
    libraryID: "preview-library",
    libraryName: "My Photos",
    onForgotten: {}
  )
}
