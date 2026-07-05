// src/apple/MapleBackupAgent/MapleBackupAgentEntryPoint.swift
//
// MapleBackupAgent — macOS LaunchAgent binary that runs the PhotoKit
// backup engine without requiring the main Maple app to be open. Same
// MapleBackup module as the app; same BackupSettings persisted by the
// app's settings panel.
//
// File is named *EntryPoint.swift rather than main.swift because @main is
// mutually exclusive with the top-level-code mode the Swift compiler enters
// when it sees a file called main.swift.
//
// Spec: .archived-plans/specs/2026-05-09-photokit-backup-design.md §15.

import Foundation
import MapleBackup
import MapleCore
#if canImport(Photos)
import Photos
#endif

@main
struct MapleBackupAgentEntryPoint {
  static func main() async throws {
    guard let s = BackupSettings.load(), s.isConfigured else {
      FileHandle.standardError.write(Data("MapleBackupAgent: no backup settings configured; exiting\n".utf8))
      return
    }
    guard let url = URL(string: s.serverURL) else {
      FileHandle.standardError.write(Data("MapleBackupAgent: invalid server URL\n".utf8))
      return
    }

    let deviceId = try DeviceIdentity.current(
      storageURL: try DeviceIdentity.defaultStorageURL())
    let sidecars = AppSupportSidecarStore(
      root: try AppSupportSidecarStore.defaultRoot())

    let appSupport = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true)
      .appendingPathComponent("Maple", isDirectory: true)
    try FileManager.default.createDirectory(at: appSupport, withIntermediateDirectories: true)
    let stateURL = appSupport.appendingPathComponent("backup-state.sqlite")
    let state = try BackupStateStore(databaseURL: stateURL)

    let queue = InProcessBackupQueue()
    // Rehydrate pending tasks from the shared state DB so we resume the
    // app's backlog instead of starting cold.
    for task in try await state.tasks(in: .pending) {
      await queue.enqueue(task, priority: .background)
    }
    for task in try await state.tasks(in: .uploading) {
      // Anything left in .uploading from a crashed run goes back to .pending.
      try await state.transition(task.id, to: .pending)
      await queue.enqueue(task, priority: .background)
    }

    // #855: backup routes are gated, so the agent must send a bearer too. It
    // reads the same Keychain-backed tokens the app saved — which requires the
    // agent to share the app's keychain access group (tracked in #905). If the
    // token isn't readable from this separate process the
    // requests go out unauthenticated and 401 — no worse than before, but the
    // required `transport:` makes that an explicit, visible state rather than a
    // silent default.
    let authClient = AuthenticatedHTTPClient(
      server: url,
      urlSession: .shared,
      tokensProvider: { try? TokenStore.load(server: url) },
      onTokensRefreshed: { try? TokenStore.save($0, server: url) },
      onSignOut: { TokenStore.clear(server: url) })
    // Separate process from the main app — no access to its in-memory
    // LocalNetworkResolver cache. LocalNetworkResolving is a stateless free
    // function for exactly this reason; re-probing fresh on every agent
    // launch is fine (arguably more correct than trusting a stale
    // foreground-process cache). `authClient` keeps using the identity `url`
    // (it only builds the token-refresh request); `upload`/`reader` get the
    // resolved (possibly-LAN) address for actual data requests.
    let effectiveURL = await LocalNetworkResolving.resolveEffectiveURL(identity: url)
    let upload = UploadClient(
      baseURL: effectiveURL,
      libraryId: s.libraryId,
      deviceId: deviceId,
      transport: { try await authClient.data(for: $0) })

    #if canImport(Photos)
    // PhotoKitAssetReader.swift is also a Compile Sources member of this
    // agent target (drag it in via Xcode Build Phases → Compile Sources).
    let reader: any AssetReader = PhotoKitAssetReader(
      deviceId: deviceId,
      geocode: GeocodeClient(baseURL: effectiveURL))
    #else
    fatalError("MapleBackupAgent requires Photos.framework")
    #endif

    let engine = BackupEngine(
      queue: queue, state: state, upload: upload,
      sidecars: sidecars, reader: reader)
    await engine.run()
  }
}
