// SourceRouter.swift — pick the right ImageSource for the current device +
// network state, per spec §09 "Device defaults".
//
// Today this is a static helper; when the Pairing UI lands we'll likely
// lift it into an `@Observable` class so it can re-route mid-session as
// reachability changes. The decision table is:
//
//   Mac  + LAN  + paired + SMB mount      -> Composed(API, LocalFolder)
//   Mac  + paired                          -> SelfHosted
//   iOS  + LAN  + paired + SMB configured  -> Composed(API, SMB)
//   iOS  + paired                          -> SelfHosted
//   no pairing                             -> caller's chosen local source
//
// Reachability is stubbed — a real implementation will use
// `Network.framework` / `NWPathMonitor`. See TODO(T5) below.

import Foundation

// MARK: - Reachability

/// Abstracted LAN-reachability check so tests and the router can both
/// pretend the server is reachable without binding to Network.framework.
public protocol NetworkReachability: Sendable {
    func isOnLAN() async -> Bool
}

/// Default stub: assumes we're always on the LAN. This is what ships until
/// the pairing UI lands.
///
/// TODO(T5): replace with an `NWPathMonitor`-backed checker that also
/// validates the server URL's reachability (ping `GET /api/health` with a
/// 1s timeout before committing to the "on LAN" branch).
public struct AlwaysOnLAN: NetworkReachability {
    public init() {}
    public func isOnLAN() async -> Bool { true }
}

// MARK: - Pairing configuration

/// What the user has configured in Preferences → Self Hosted.
public struct PairingConfig: Sendable {
    public let serverURL: URL
    public let token: String?
    /// When set, the LAN fast path is enabled: the SMB share (iOS) or local
    /// filesystem mount (macOS) at this path is known to mirror the same
    /// folder the server has indexed.
    public let fastPathFolder: String?
    public let smbCredentials: SMBSource.Credentials?

    public init(serverURL: URL,
                token: String?,
                fastPathFolder: String? = nil,
                smbCredentials: SMBSource.Credentials? = nil) {
        self.serverURL = serverURL
        self.token = token
        self.fastPathFolder = fastPathFolder
        self.smbCredentials = smbCredentials
    }
}

// MARK: - SourceRouter

public enum SourceRouter {

    /// Decide which source to use given the current pairing + reachability.
    /// `localFallback` is the local source (FilesystemSource / PhotoKitSource)
    /// the user picked when no server is paired. Pass `nil` to force a
    /// pairing-required branch.
    public static func resolve(
        pairing: PairingConfig?,
        reachability: NetworkReachability = AlwaysOnLAN(),
        localFallback: (any ImageSource)? = nil
    ) async -> any ImageSource {
        // No pairing: whatever local source the user picked.
        guard let pairing else {
            if let localFallback { return localFallback }
            // Last-resort: an empty self-hosted source at a bogus URL so
            // the call site still has a non-nil `any ImageSource`. Caller
            // should check `pairing` before calling us to avoid this branch.
            return SelfHostedSource(baseURL: URL(string: "http://localhost")!,
                                    token: nil)
        }

        let onLAN = await reachability.isOnLAN()
        let api = SelfHostedSource(baseURL: pairing.serverURL, token: pairing.token)

        guard onLAN, let fastPathFolder = pairing.fastPathFolder else {
            return api
        }

        #if os(macOS)
        // Mac + LAN + paired + mount present: Composed(API, LocalFolder).
        // The mount appears as a regular filesystem folder to the OS.
        let mountURL = URL(fileURLWithPath: fastPathFolder)
        let fs = FilesystemSource()
        do {
            try await fs.open(folderURL: mountURL)
            return ComposedSource(metadata: api,
                                  bytes: fs,
                                  coverage: .same(folder: fastPathFolder))
        } catch {
            // Mount missing or permission denied — fall back to the API only.
            return api
        }
        #else
        // iOS / iPadOS: Composed(API, SMB) when credentials are on file.
        guard let creds = pairing.smbCredentials else { return api }
        let smb = SMBSource()
        do {
            try await smb.connect(credentials: creds, remotePath: fastPathFolder)
            return ComposedSource(metadata: api,
                                  bytes: smb,
                                  coverage: .same(folder: fastPathFolder))
        } catch {
            return api
        }
        #endif
    }
}
