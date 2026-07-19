// src/apple/Maple TV/IdleActivityMonitor.swift
import Foundation

/// A resettable idle countdown for the screensaver (#2121 F3). Every
/// `poke()` cancels whatever countdown is pending and starts a fresh one;
/// `onIdle` fires exactly once per uninterrupted `interval`-long stretch
/// with no `poke()` — the same "cancel any existing, then replace" shape
/// `LightTableScreen.startCycle()` uses for its own glide timer, applied
/// here to a single-shot countdown instead of a repeating loop. Because
/// every earlier `Task` is cancelled before a new one is created, only the
/// most recently started countdown can ever reach its `onIdle()` call —
/// there's no race where two overlapping countdowns both fire.
///
/// `RootTabView` owns one instance, feeds it `poke()` from every
/// interaction signal it can observe, and calls `stop()` from
/// `.onDisappear` so the pending countdown `Task` doesn't outlive the
/// view (Global Constraint: no task leaks).
@MainActor
final class IdleActivityMonitor {
  private let interval: Duration
  private let onIdle: () -> Void
  private var countdownTask: Task<Void, Never>?
  /// Bumped by every `poke()` and `stop()`. The countdown captures the
  /// value it was started with and only fires `onIdle()` if it still
  /// matches at wake time — so a countdown superseded by a newer `poke()`
  /// (or torn down by `stop()`) can't fire even in the narrow window
  /// where cancellation hasn't propagated by the post-sleep check. Makes
  /// "latest poke wins" explicit rather than resting on actor-reentrancy
  /// reasoning, matching the generation-guard idiom used across the app.
  private var generation = 0

  /// `interval` is injectable so tests/debug builds can shrink it — see
  /// `RootTabView.idleInterval`, which reads `MAPLE_TV_IDLE_INTERVAL_SECONDS`
  /// from the process environment (same launch-environment pattern as
  /// `MAPLE_UITEST_FIXTURE` in `MapleApp.swift`) and falls back to the
  /// product default of 3 minutes.
  init(interval: Duration = .seconds(180), onIdle: @escaping () -> Void) {
    self.interval = interval
    self.onIdle = onIdle
  }

  /// Resets the countdown to zero. Call once to arm the monitor (e.g. on
  /// the host view's `.onAppear`) and again from every subsequent
  /// interaction signal.
  func poke() {
    countdownTask?.cancel()
    generation &+= 1
    let g = generation
    countdownTask = Task { [weak self, interval] in
      try? await Task.sleep(for: interval)
      guard let self, !Task.isCancelled, g == self.generation else { return }
      self.onIdle()
    }
  }

  /// Cancels the pending countdown without starting a new one. Call from
  /// `.onDisappear`, and whenever the host wants the monitor to stand
  /// down entirely (`RootTabView` pauses it while the user is already on
  /// the Light Table tab — see that file).
  func stop() {
    generation &+= 1
    countdownTask?.cancel()
    countdownTask = nil
  }
}
