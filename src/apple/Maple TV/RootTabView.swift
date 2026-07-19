// src/apple/Maple TV/RootTabView.swift
import Foundation
import MapleCloudKit
import SwiftUI
import UIKit

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
///
/// F3 (#2121) adds the idle screensaver: `idleMonitor` fires after
/// `Self.idleInterval` of no observed Siri Remote activity, which flips
/// `isScreensaverActive` and shows `LightTableScreen` full-bleed —
/// *without* touching `selectedTab`, so whichever tab the user was
/// actually on is still there the moment the screensaver is dismissed.
/// See `screensaverInputCapture` for how dismissal is detected and
/// `idleInterval`/`enterScreensaver()`/`exitScreensaver()` for the rest of
/// the state machine.
///
/// F3 review Critical fix: the top-level `.onMoveCommand` below is only a
/// *fallback* on tvOS — it never fires while a focusable child (a photo
/// grid cell, a `PhotoViewerScreen` control) actually consumes the
/// directional move by shifting focus to a sibling. That made arrow-keying
/// through the grid — the single most common activity on this screen — a
/// blind spot for the idle monitor. Fixed by also observing
/// `UIFocusSystem.didUpdateNotification`, which UIKit posts app-wide on
/// *every* focus move anywhere in the hierarchy, regardless of whether a
/// descendant consumed it locally. See `focusUpdateObserver` and
/// `handleFocusUpdate()`.
struct RootTabView: View {
  let session: TVCloudSession
  let libraryID: String
  let libraryName: String
  let onForgotten: () -> Void

  /// The tab the user actually picked. Never mutated by the screensaver
  /// entering or leaving — that's the whole point of keeping it separate
  /// from `isScreensaverActive`.
  @State private var selectedTab: RootTab = .timeline
  @State private var isScreensaverActive = false
  @State private var idleMonitor: IdleActivityMonitor?
  @FocusState private var isScreensaverCaptureFocused: Bool

  /// Token for the app-wide `UIFocusSystem.didUpdateNotification`
  /// observer (F3 review Critical fix). Stored so `.onDisappear` can
  /// `removeObserver` it — same "arm on appear, tear down on disappear"
  /// discipline as `idleMonitor` itself, just via `NotificationCenter`
  /// instead of a `Task`.
  @State private var focusUpdateObserver: NSObjectProtocol?

  /// Default 3 minutes; overridable via `MAPLE_TV_IDLE_INTERVAL_SECONDS`
  /// in the process environment for fast manual/sim verification — same
  /// launch-environment pattern as `MAPLE_UITEST_FIXTURE`
  /// (`MapleApp.swift`), not gated behind `#if DEBUG` for the same reason
  /// that one isn't: it only ever does anything if something explicitly
  /// sets the variable when launching the process.
  private static var idleInterval: Duration {
    guard
      let raw = ProcessInfo.processInfo.environment["MAPLE_TV_IDLE_INTERVAL_SECONDS"],
      let seconds = Double(raw), seconds > 0
    else { return .seconds(180) }
    return .seconds(seconds)
  }

  var body: some View {
    ZStack(alignment: .top) {
      // The selected tab stays mounted underneath the screensaver rather
      // than being swapped out for it — destroying `TimelineScreen` on
      // screensaver activation would throw away its scroll position and
      // loaded view model, forcing a full reload when the screensaver is
      // dismissed. `.disabled` while the screensaver is up pulls its
      // focusable content out of the focus engine's candidate set so the
      // only thing a directional press can land on is
      // `screensaverInputCapture` (see `screensaverOverlay`).
      content
        .disabled(isScreensaverActive)

      if isScreensaverActive {
        screensaverOverlay
      } else {
        TabBar(selectedTab: $selectedTab)
          .padding(.top, 48)
          .frame(maxWidth: .infinity, alignment: .center)

        // `TimelineTopBar` already carries its own "Forget this server"
        // control (top-trailing) for the Timeline tab — this chrome-level
        // one only renders for the other two tabs, which have no top bar
        // of their own, so the pairing-reversal path (milestone C) stays
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
    // NB: the Siri Remote *command* handlers (move / Menu / Play-Pause)
    // live on `screensaverInputCapture`, not here — attaching
    // `.onExitCommand` to this always-present root would trap the Menu
    // button in normal mode (it would poke the idle timer instead of
    // letting tvOS background the app). Normal-mode activity is already
    // covered by the `UIFocusSystem.didUpdateNotification` observer
    // (below) and this `selectedTab` change, so the root only needs the
    // tab-change signal.
    .onChange(of: selectedTab) { _, _ in handleInteraction() }
    .onAppear {
      let monitor = IdleActivityMonitor(interval: Self.idleInterval, onIdle: enterScreensaver)
      idleMonitor = monitor
      armIdleMonitor()
      focusUpdateObserver = NotificationCenter.default.addObserver(
        forName: UIFocusSystem.didUpdateNotification,
        object: nil,
        queue: .main
      ) { _ in
        handleFocusUpdate()
      }
    }
    .onDisappear {
      idleMonitor?.stop()
      idleMonitor = nil
      if let observer = focusUpdateObserver {
        NotificationCenter.default.removeObserver(observer)
      }
      focusUpdateObserver = nil
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

  /// The full-bleed screensaver drawn over the still-mounted `content`.
  /// Its own `LightTableScreen` runs the same ambient glide cycle as the
  /// tab (see that file, "cycles forever with no interaction required")
  /// and its opaque warm-paper background hides the tab underneath.
  /// `.disabled(true)` pulls its print cards out of the focus engine's
  /// candidate set — combined with the underlying tab being disabled too
  /// (see `body`), the only focusable candidate left is
  /// `screensaverInputCapture`, so every directional press reaches its
  /// command handlers and dismisses the screensaver.
  private var screensaverOverlay: some View {
    ZStack {
      LightTableScreen(session: session, libraryID: libraryID)
        .disabled(true)
      screensaverInputCapture
    }
  }

  /// A transparent, full-screen focus target shown only in screensaver
  /// mode. It grabs focus the moment the screensaver appears
  /// (`.onAppear`), so every one of its command handlers fires directly
  /// on it rather than on whatever was focused before the screensaver
  /// took over — the disabled `LightTableScreen` underneath has no
  /// focusable candidates left to compete for that focus (see `content`
  /// above). The Siri Remote command handlers live *here* rather than on
  /// the root so they only intercept input while the screensaver is up:
  /// a directional move, a Menu (`.onExitCommand`), a Play-Pause, or a
  /// Select press (`.onTapGesture` — the primary button, which the
  /// command modifiers don't cover) all funnel through the same
  /// `handleInteraction()` used elsewhere, so exiting the screensaver is
  /// just one more "poke."
  private var screensaverInputCapture: some View {
    Color.clear
      .contentShape(Rectangle())
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .focusable()
      .focused($isScreensaverCaptureFocused)
      .onAppear { isScreensaverCaptureFocused = true }
      .onMoveCommand { _ in handleInteraction() }
      .onExitCommand { handleInteraction() }
      .onPlayPauseCommand { handleInteraction() }
      .onTapGesture { handleInteraction() }
      .accessibilityHidden(true)
  }

  /// Fed by every interaction signal this view observes: the screensaver's
  /// own command handlers (`screensaverInputCapture`), a `selectedTab`
  /// change (tapping a different tab pill), and — crucially — every
  /// app-wide focus move via `handleFocusUpdate()`. That last one is why
  /// panning focus between grid cells inside `TimelineScreen`, which the
  /// focus engine resolves locally and never bubbles up as an
  /// `onMoveCommand`, still counts as activity: the
  /// `UIFocusSystem.didUpdateNotification` observer catches it. So there
  /// is no idle-monitor blind spot for ordinary grid browsing.
  private func handleInteraction() {
    if isScreensaverActive {
      exitScreensaver()
    } else {
      armIdleMonitor()
    }
  }

  /// Handler for the app-wide `UIFocusSystem.didUpdateNotification`
  /// observer (F3 review Critical fix). Fires on *every* focus move
  /// anywhere in the hierarchy — including moves a focusable descendant
  /// (a grid cell, a `PhotoViewerScreen` control) resolves locally without
  /// ever reaching `onMoveCommand` — so arrow-keying through the photo
  /// grid now correctly counts as activity instead of silently expiring
  /// the idle timer underneath the user.
  ///
  /// Deliberately does **not** reuse `handleInteraction()` wholesale:
  /// while the screensaver is active, `screensaverInputCapture` grabs
  /// focus for itself the instant it appears (its own `.onAppear`), which
  /// is itself a focus move and would post this exact notification —
  /// routing that through `handleInteraction()`'s
  /// `exitScreensaver()` branch would dismiss the screensaver in the same
  /// frame it just activated. Genuine dismissal while the screensaver is
  /// up is already fully covered by the command handlers on
  /// `screensaverInputCapture` (move / Menu / Play-Pause / Select) —
  /// it's the *only* focusable candidate in that mode, so every
  /// directional press falls through to those as a no-candidate-to-move-to
  /// fallback (see that view's doc comment). So this handler only ever
  /// pokes the monitor, and only while the screensaver is *not* showing;
  /// it never exits the screensaver itself.
  private func handleFocusUpdate() {
    guard !isScreensaverActive else { return }
    armIdleMonitor()
  }

  private func armIdleMonitor() {
    // Paused while the user is already on the Light Table tab by choice
    // — there's nothing for the screensaver to usefully take over, and
    // firing it there would just `.disabled(true)` the same screen the
    // user is actively looking at out from under them.
    guard selectedTab != .lightTable else {
      idleMonitor?.stop()
      return
    }
    idleMonitor?.poke()
  }

  private func enterScreensaver() {
    isScreensaverActive = true
  }

  private func exitScreensaver() {
    isScreensaverActive = false
    armIdleMonitor()
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
