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
/// The Menu (`MenuScreen`) is where Timeline / Light Table / Search are
/// chosen and where Log Out (unpair) lives, so the content screens carry no
/// navigation chrome of their own.
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

  var body: some View {
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
    case .lightTable:
      LightTableScreen(session: session, libraryID: libraryID)
        .onExitCommand { screen = .menu }
    case .search:
      SearchScreen(session: session, libraryID: libraryID)
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
}
