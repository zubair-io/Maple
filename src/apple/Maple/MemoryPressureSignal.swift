// MemoryPressureSignal.swift — cross-layer memory-pressure signal (#2037).
//
// `MapleApp.installMemoryPressureObserver()` fires at the process level
// (macOS `DispatchSource.makeMemoryPressureSource`, iOS
// `UIApplication.didReceiveMemoryWarningNotification`), outside any SwiftUI
// view context. It already forwards the signal to the thumbnail cache and
// the rendered-preview cache directly (both process-wide singletons), but
// the large per-editor buffers — the decoded-image cache, deep-zoom tiles,
// and GPU-live sessions — live on `EditSession` instances held in
// `AppShell.sessions`, which is plain SwiftUI `@State` with no static/shared
// handle a non-View singleton can reach.
//
// This mirrors the `DeepLinkRouter` / `DocumentOpenRouter` idiom already
// used for the same shape of problem (a scene-level signal that a View
// needs to react to): an `@MainActor @Observable` singleton with a bumped
// counter, bound into `AppShell` as `@State` and observed via
// `.onChange(of:)`. `AppShell` is the one place that can see `sessions` and
// decide which are active vs. inactive (the same signal `pruneInactiveSessions()`
// already reads), so the actual fan-out logic lives there.
//
// Background-eviction (iOS `scenePhase == .background`) does NOT go through
// this signal — `AppShell` already observes `scenePhase` directly for the
// #2009 preview-persist-on-exit path, so the background trim is added to
// that existing observer instead of introducing a second delivery path for
// the same information.

import Foundation
import Observation

@MainActor
@Observable
public final class MemoryPressureSignal {
    public static let shared = MemoryPressureSignal()

    /// Bumped each time the OS reports memory pressure (macOS warn/critical
    /// via `DispatchSource.makeMemoryPressureSource`, iOS
    /// `UIApplication.didReceiveMemoryWarningNotification`). Observable so
    /// `AppShell` can react by releasing every INACTIVE session's transient
    /// buffers — the active (on-screen) session is left alone so the
    /// current edit doesn't stall.
    public private(set) var pressureEventCount: Int = 0

    private init() {}

    /// Record a memory-pressure event. Called from
    /// `MapleApp.installMemoryPressureObserver()`'s event handler.
    public func signalPressure() {
        pressureEventCount &+= 1
    }
}
