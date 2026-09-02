// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/ApnsPushRegistrar.swift
//
// Registers this File Provider extension process for APNs push-to-signal
// wakeups (#1025) via PushKit's `.fileProvider` push type — Apple's
// documented mechanism for waking a File Provider extension in the
// background without a persistent connection ("Using push notifications
// to signal changes"). Runs INSIDE the extension process (not the
// containing app) because the extension is what the OS keeps warm and
// what needs to wake on push — same reasoning as `ChangeFeedClient`
// living here rather than in the app target.
//
// Owned by `FileProviderExtensionCore`, one instance per domain.

import FileProvider
import Foundation
import OSLog
import PushKit

final class ApnsPushRegistrar: NSObject {
    private let domain: NSFileProviderDomain
    private let registrationClient: ApnsDeviceRegistrationClient
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "apns-push")
    private var registry: PKPushRegistry?
    /// Invoked after every incoming push has signalled the working-set
    /// enumerator. Lets `FileProviderExtensionCore` observe a wake the
    /// same way it observes an SSE event via `ChangeFeedClient`'s
    /// `onEvent` — nothing extra to do today (the working-set signal is
    /// the whole job; the OS pulls the delta via the existing `?since=`
    /// cursor on its own), but tests hook this to assert a push actually
    /// drove a signal without needing a live push.
    private let onWake: (@Sendable () async -> Void)?

    init(
        domain: NSFileProviderDomain,
        registrationClient: ApnsDeviceRegistrationClient,
        onWake: (@Sendable () async -> Void)? = nil
    ) {
        self.domain = domain
        self.registrationClient = registrationClient
        self.onWake = onWake
        super.init()
    }

    /// Starts PushKit registration. Idempotent — a second call is a
    /// no-op; the registry, once created, keeps redelivering the current
    /// token to `didUpdate` on its own, so there is nothing to refresh by
    /// re-registering.
    func start() {
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: nil)
        registry.delegate = self
        self.registry = registry
        // Setting desiredPushTypes triggers the didUpdate callback with
        // the current token (or immediately, if one is already cached).
        registry.desiredPushTypes = [.fileProvider]
    }

    /// Torn down alongside the rest of `FileProviderExtensionCore`'s
    /// state in `invalidate()`. Clearing `desiredPushTypes` tells PushKit
    /// this process no longer wants pushes; it does not itself invalidate
    /// the token (only the OS decides that), so a re-launched extension
    /// process re-registers cleanly.
    func stop() {
        registry?.desiredPushTypes = []
        registry = nil
    }

    // MARK: - Testable seams
    //
    // `PKPushCredentials` and `PKPushPayload` have no public initializer,
    // so a unit test cannot construct real ones to drive
    // `PKPushRegistryDelegate`'s methods directly. These two `async`
    // methods hold the ENTIRE behavior of those delegate callbacks in
    // terms of plain values a test CAN construct (a hex token string; no
    // payload at all, since the push carries none) — the delegate methods
    // below are one-line wrappers that extract that plain value and hand
    // off. `ApnsPushRegistrarTests` exercises these directly.

    /// Reports a fresh push token to the server. Internal (not private)
    /// so tests can call it without needing a real `PKPushCredentials`.
    func handleTokenUpdate(_ deviceToken: String) async {
        log.notice("APNs push token updated")
        #if os(iOS)
            let platform = "ios"
        #else
            let platform = "macos"
        #endif
        await registrationClient.register(
            deviceToken: deviceToken,
            platform: platform,
            environment: .current)
    }

    /// Signals the working-set enumerator so the OS pulls the delta via
    /// the existing `?since=` cursor, then calls `onWake` (test hook) and
    /// `completion` (the real PushKit contract — MUST be called or the
    /// system considers this delivery attempt hung). Internal so tests
    /// can call it without needing a real `PKPushPayload`.
    func handleIncomingPush(completion: @escaping () -> Void) async {
        log.notice("push received — signalling working set")
        if let mgr = NSFileProviderManager(for: domain) {
            try? await mgr.signalEnumerator(for: .workingSet)
        }
        await onWake?()
        completion()
    }
}

extension ApnsPushRegistrar: PKPushRegistryDelegate {
    func pushRegistry(
        _ registry: PKPushRegistry,
        didUpdate pushCredentials: PKPushCredentials,
        for type: PKPushType
    ) {
        guard type == .fileProvider else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        Task { await self.handleTokenUpdate(token) }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        guard type == .fileProvider else { return }
        // No stored "last known token" to unregister here by design — the
        // extension process is short-lived, re-registers fresh on next
        // launch (or immediately, if `desiredPushTypes` is still set and
        // the OS mints a replacement token), and a token the server can
        // no longer reach also gets pruned server-side the next time
        // APNs reports it dead (410 Unregistered).
        log.notice("APNs push token invalidated")
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .fileProvider else {
            completion()
            return
        }
        Task { await self.handleIncomingPush(completion: completion) }
    }
}
