// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/ApnsDeviceRegistrationClient.swift
//
// Reports this device's APNs push token to the Maple server (#1025) so
// the server-side ApnsPushTrigger can wake this File Provider extension
// via a silent push instead of it holding a persistent SSE connection
// open. Registration is per (user, device) — NOT per library: a File
// Provider domain covers a whole connected server
// (FileProviderDomainController.domainIdentifier(for:) keys on
// scheme+host+port only), with every library on that server surfacing as
// a sub-tree inside that one domain, so there is no per-library push
// channel to scope a registration to. See the matching server-side doc
// comment in src/api/src/apns/apns-devices.repo.ts.
//
// Mirrors `POST/DELETE /api/apns/devices` in src/api/src/routes/apns-devices.ts.

import Foundation
import OSLog

/// Wire body for `POST /api/apns/devices`.
struct ApnsDeviceRegistrationBody: Encodable {
    let deviceToken: String
    let platform: String
    let environment: String

    private enum CodingKeys: String, CodingKey {
        case deviceToken = "device_token"
        case platform
        case environment
    }
}

/// Wire body for `DELETE /api/apns/devices`.
struct ApnsDeviceUnregistrationBody: Encodable {
    let deviceToken: String

    private enum CodingKeys: String, CodingKey {
        case deviceToken = "device_token"
    }
}

/// APNs environment a device token was minted against, mirroring the
/// server's `ApnsEnvironment` type (`src/api/src/db/schema.ts`). Sending
/// to the wrong APNs host for a given token is always rejected, so this
/// must travel with the token on every registration.
enum ApnsEnvironment: String {
    case sandbox
    case production

    /// Best-effort inference from the build configuration, NOT the
    /// authoritative source (that's the actual `aps-environment` entitlement
    /// baked into the code signature at build time — see the caveat below).
    /// A Debug build launched from Xcode is always signed with a
    /// development provisioning profile, which only ever mints sandbox
    /// tokens; a Release build distributed via TestFlight or the App
    /// Store is always signed for production. This is the same heuristic
    /// commonly used across the ecosystem when the embedded provisioning
    /// profile isn't parsed directly, and it's correct for every real
    /// Maple distribution channel.
    ///
    /// Known gap: a Release-configuration build launched directly from
    /// Xcode (not archived) can still carry a development signing
    /// identity, in which case this reports `.production` while the
    /// actual token is sandbox-only, and the server's send to the
    /// production APNs host is rejected. That failure is silent but not
    /// silent-forever: `ApnsPushTrigger` logs `push rejected` server-side
    /// on every coalesced burst, and the extension's existing SSE
    /// fallback keeps the working set current regardless, so the
    /// consequence is "push doesn't fire in this one unusual local
    /// configuration," not data loss. Reading the actual entitlement from
    /// the code signature (`SecTaskCopyValueForEntitlement`, as
    /// `TokenStore.swift` already does for `keychain-access-groups`) would
    /// close this gap, but that same file documents entitlement
    /// introspection as unreliable on iOS — fixing this cross-platform
    /// needs embedded-provisioning-profile parsing, which is more risk
    /// than this edge case warrants without a signed device to verify it
    /// against.
    static var current: ApnsEnvironment {
        #if DEBUG
            return .sandbox
        #else
            return .production
        #endif
    }
}

/// Registers/unregisters this device's push token with the Maple server.
/// One instance per domain (server), owned by `FileProviderExtensionCore`
/// alongside its `ChangeFeedClient` and `ApnsPushRegistrar`.
///
/// An `actor`, not a lock-guarded class: `hasRegisteredSuccessfully` is
/// read from `FileProviderExtensionCore`'s async APNs-confirmation task
/// (deciding whether to stop the SSE fallback) while `register(…)` writes
/// it from PushKit's delegate callback — actor isolation is the simplest
/// correct way to serialize that without a second hand-rolled `NSLock`
/// next to `server`'s.
actor ApnsDeviceRegistrationClient {
    private let http: AuthenticatedHTTPClient
    private var server: URL
    private let log = Logger(
        subsystem: "app.justmaple.aperture.fileprovider",
        category: "apns-registration")
    /// True once a `register(…)` call has been confirmed 2xx by the
    /// server at least once. `FileProviderExtensionCore` polls this to
    /// decide whether push is genuinely active before it stops the SSE
    /// fallback — never flips back to false on a later failure (a
    /// transient registration hiccup after the first success shouldn't
    /// resurrect a held SSE connection; the token stays registered
    /// server-side until APNs itself reports it dead).
    private(set) var hasRegisteredSuccessfully = false

    init(server: URL, http: AuthenticatedHTTPClient) {
        self.server = server
        self.http = http
    }

    /// Swaps the address used for future requests — mirrors
    /// `ChangeFeedClient.updateServer(_:)` and `RemoteCatalog
    /// .updateServer(_:)`'s identity-URL-to-LAN-address migration. Only
    /// affects requests issued after the call; nothing to tear down since
    /// registration/unregistration are one-shot requests, not a held
    /// connection.
    func updateServer(_ url: URL) {
        server = url
    }

    /// Best-effort — logs and returns on any failure rather than
    /// throwing. A registration that doesn't land just means this device
    /// keeps relying on the SSE fallback (`ChangeFeedClient`) until the
    /// next successful registration (PushKit redelivers the token
    /// periodically, and every domain init retries).
    func register(
        deviceToken: String,
        platform: String,
        environment: ApnsEnvironment
    ) async {
        var req = URLRequest(url: server.appending(path: "/api/apns/devices"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = ApnsDeviceRegistrationBody(
            deviceToken: deviceToken,
            platform: platform,
            environment: environment.rawValue)
        guard let payload = try? JSONEncoder().encode(body) else {
            log.error("register: failed to encode body")
            return
        }
        req.httpBody = payload
        do {
            let (_, resp) = try await http.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            guard (200..<300).contains(code) else {
                log.error("register failed status=\(code, privacy: .public)")
                return
            }
            hasRegisteredSuccessfully = true
            log.notice(
                "registered APNs device token (platform=\(platform, privacy: .public) environment=\(environment.rawValue, privacy: .public))"
            )
        } catch {
            log.error("register failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Best-effort, same reasoning as `register`. Not currently called
    /// automatically anywhere in MapleCore — `ApnsPushRegistrar` does NOT
    /// call this when PushKit invalidates a token (see that type's
    /// `didInvalidatePushTokenFor`, which explains why: the extension
    /// process is short-lived and has no stored "current token" to pass
    /// here once invalidated). Server-side pruning on a 410 from APNs is
    /// the actual cleanup path today. This method exists as the natural,
    /// tested counterpart to `register` for a future caller — e.g. the
    /// app-side `FileProviderDomainController.disable()` proactively
    /// unregistering on sign-out/domain removal — rather than as
    /// currently-wired behavior.
    func unregister(deviceToken: String) async {
        var req = URLRequest(url: server.appending(path: "/api/apns/devices"))
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard
            let payload = try? JSONEncoder().encode(
                ApnsDeviceUnregistrationBody(deviceToken: deviceToken))
        else {
            log.error("unregister: failed to encode body")
            return
        }
        req.httpBody = payload
        do {
            let (_, resp) = try await http.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            guard (200..<300).contains(code) else {
                log.error("unregister failed status=\(code, privacy: .public)")
                return
            }
            log.notice("unregistered APNs device token")
        } catch {
            log.error("unregister failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Response shape for `GET /api/apns/config` — mirrors the server's
    /// `ApnsConfigResponse` (`src/api/src/routes/apns-config.ts`).
    private struct ApnsSettingsConfig: Decodable {
        let enabled: Bool
        let credentialsConfigured: Bool

        private enum CodingKeys: String, CodingKey {
            case enabled
            case credentialsConfigured = "credentials_configured"
        }
    }

    /// Whether the operator has push enabled AND the server process has
    /// real MAPLE_APNS_* credentials configured — i.e. whether push is
    /// genuinely usable right now, not just toggled on. Returns `false`
    /// on any failure (network error, non-2xx, decode failure): the safe
    /// default is "not confirmed", which keeps the SSE fallback running
    /// rather than risk a false positive that leaves the extension with
    /// no live channel.
    func isServerPushConfigured() async -> Bool {
        var req = URLRequest(url: server.appending(path: "/api/apns/config"))
        req.httpMethod = "GET"
        do {
            let (data, resp) = try await http.data(for: req)
            guard let httpResp = resp as? HTTPURLResponse, (200..<300).contains(httpResp.statusCode)
            else {
                return false
            }
            guard let cfg = try? JSONDecoder().decode(ApnsSettingsConfig.self, from: data) else {
                return false
            }
            return cfg.enabled && cfg.credentialsConfigured
        } catch {
            return false
        }
    }

    /// Polls `hasRegisteredSuccessfully` until it flips true or
    /// `timeoutMs` elapses, so `FileProviderExtensionCore` never waits
    /// indefinitely to decide whether to stop its SSE fallback — PushKit
    /// token delivery timing is outside this process's control.
    func waitUntilRegistered(pollIntervalMs: UInt64 = 200, timeoutMs: UInt64 = 5000) async -> Bool {
        if hasRegisteredSuccessfully { return true }
        let deadlineNs = DispatchTime.now().uptimeNanoseconds + timeoutMs * 1_000_000
        while DispatchTime.now().uptimeNanoseconds < deadlineNs {
            try? await Task.sleep(nanoseconds: pollIntervalMs * 1_000_000)
            if hasRegisteredSuccessfully { return true }
        }
        return hasRegisteredSuccessfully
    }
}
