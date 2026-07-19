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
/// Light Table is `LightTableScreen` (F2, #2121) as of this file; Search
/// (milestone E) is still a placeholder — see `SearchTabPlaceholder.swift`.
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
      LightTableScreen(session: session, libraryID: libraryID)
    case .search:
      SearchTabPlaceholder()
    }
  }

  private var forgetButton: some View {
    Button("Forget this server", role: .destructive, action: onForgotten)
      .accessibilityLabel("Forget this server")
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
