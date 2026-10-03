// src/apple/Maple TV/RootTabView.swift
import Foundation
import MapleCloudKit
import SwiftUI

/// Connected root once a library is selected. `ConnectedScreen` presents
/// this as soon as `session.selectedLibraryID` resolves.
///
/// Navigation is menu-driven (there is no on-screen tab bar): the app
/// launches straight into the **Timeline** (`screen == .timeline`), the Siri
/// Remote's Menu button (Back) returns to the **Menu** hub from any content
/// screen, and Back again from the Menu backgrounds the app (tvOS default —
/// the menu attaches no `onExitCommand`, so the press isn't intercepted).
/// The Menu (`MenuScreen`) is where Timeline / Memories / Light Table /
/// Search / Map are chosen and where Log Out (unpair) lives, so the content
/// screens carry no navigation chrome of their own.
///
/// There is no idle screensaver: the Light Table is only shown when the user
/// picks it from the Menu; nothing auto-activates.
struct RootTabView: View {
  let session: TVCloudSession
  let libraryID: String
  let libraryName: String
  let onForgotten: () -> Void

  /// The screen the user is on. Starts at `.timeline` (the app opens straight
  /// into it); Back moves it to `.menu`, and the menu's rows move it to a
  /// content screen.
  @State private var screen: RootScreen = .timeline
  /// A `maple-tv://` link from the Top Shelf. Both link kinds land on the
  /// Memories screen; a `.memory` link additionally carries an id that
  /// `MemoriesScreen` consumes once its collections load.
  @Environment(TVDeepLinkRouter.self) private var deepLinks

  var body: some View {
    routed
      // A link can arrive while the app is already running (selecting a
      // second memory from the Home screen) as well as at launch, so this
      // watches rather than reading once in `onAppear`.
      .onChange(of: deepLinks.pending) { _, link in
        if link != nil { screen = .memories }
      }
      .onAppear {
        if deepLinks.pending != nil { screen = .memories }
      }
      // Fill the Home screen's Top Shelf from here rather than from the
      // Memories screen: this runs on every connected launch, whereas
      // Memories is a screen most sessions never visit — and the shelf is
      // most useful to someone who has NOT opened the app.
      .task(id: libraryID) {
        await TopShelfMaintainer.refreshIfNeeded(session: session, libraryID: libraryID)
      }
  }

  @ViewBuilder
  private var routed: some View {
    switch screen {
    case .menu:
      // No `.onExitCommand`: at the hub, Back is the tvOS default (background
      // the app).
      MenuScreen(
        libraryName: libraryName,
        onSelect: { screen = $0 },
        onForgotten: onForgotten
      )
    case .timeline:
      TimelineScreen(session: session, libraryID: libraryID, libraryName: libraryName)
        .onExitCommand { screen = .menu }
    case .memories:
      MemoriesScreen(session: session, libraryID: libraryID)
        .onExitCommand { screen = .menu }
    case .lightTable:
      LightTableScreen(session: session, libraryID: libraryID)
        .onExitCommand { screen = .menu }
    case .search:
      SearchScreen(session: session, libraryID: libraryID)
        .onExitCommand { screen = .menu }
    case .map:
      TVMapScreen(session: session, libraryID: libraryID)
        .onExitCommand { screen = .menu }
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
  .environment(TVDeepLinkRouter())
}
