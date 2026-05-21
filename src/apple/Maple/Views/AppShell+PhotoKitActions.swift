// AppShell+PhotoKitActions.swift — PhotoKit + SMB source loading, lifted
// out of AppShell.swift as part of the multi-PR split tracked in #123
// (slice 3).
//
// Contents:
//   • requestPhotosAccess / loadPhotos / grantPhotosAccessAndLoad — the
//     PhotoKit-library filter flow (deferred-permission style: clicking a
//     filter never ambushes the user with a system dialog; the request
//     fires from the empty-state "Grant Access" button)
//   • openLocalPhotoKitAsset — open a single PhotoKit asset in the editor
//     (used by the merged cloud-timeline's local-only cells)
//   • connectSMB / connectSavedSMB — SMB share connect flow (lives here
//     alongside PhotoKit as a sibling "local-but-not-folder" source path)
//
// `grantPhotosAccessAndLoad` was `fileprivate` in the original file (it's
// invoked from BrowseGrid via a closure captured in AppShell.body). With
// the move to a sibling file it's now default-internal so the closure
// still resolves; the BrowseGrid call site is unchanged.

import SwiftUI
import MapleCore

@MainActor
extension AppShell {
    // MARK: - PhotoKit

    @MainActor
    func requestPhotosAccess() {
        Task { @MainActor in
            let status = await PhotoKitLibrary.requestAuthorization()
            if status == .authorized || status == .limited {
                loadPhotos(filter: .all)
            }
        }
    }

    @MainActor
    func loadPhotos(filter: PhotoKitFilter) {
        librarySelection = .photosFilter(filter)
        libraryTitle = filter.title
        mode = .browse
        currentRootBookmark = nil
        // Selecting a Photos filter must not ambush the user with a permission
        // dialog. If PhotoKit isn't authorised yet, put the grid into the
        // "auth needed" empty state; the actual request happens when the user
        // taps the grid's "Grant Access" button.
        let status = PhotoKitLibrary.authorizationStatus()
        guard status == .authorized || status == .limited else {
            browseVM.setPhotosAuthNeeded()
            return
        }
        // Clear the prior source's assets immediately so the user sees the
        // grid flip to "Loading…" the moment they click a Photos filter,
        // instead of staring at the previous folder's tiles while the
        // PhotoKit fetch + enumeration runs in the background. Without this,
        // a user clicking "All Photos" from a populated filesystem folder
        // perceives the click as having done nothing for several seconds —
        // particularly painful on libraries large enough to make
        // `images()` enumeration take noticeable wall time.
        browseVM.beginLoadingPhotosFilter()
        Task { @MainActor in
            do {
                let source = try PhotoKitSource()
                try await source.fetchAssets(for: filter)
                // PhotoKit-library view is always single-source. The merged
                // Photos+Cloud view belongs on the cloud-library timeline
                // (where the user is browsing the backup destination), not
                // here. Keep mergedCloudSource nil for consistency.
                mergedCloudSource = nil
                await browseVM.loadSource(source)
                SourceSelectionStore.save(.photoKitFilter(filter))
            } catch {
                browseVM.loadError = error
            }
        }
    }

    /// Fired by the grid's empty-state "Grant Access" button. Requests
    /// PhotoKit authorisation, then loads the currently-selected filter.
    @MainActor
    func grantPhotosAccessAndLoad() {
        Task { @MainActor in
            let status = await PhotoKitLibrary.requestAuthorization()
            guard status == .authorized || status == .limited else { return }
            // User may have selected a filter before granting; fall back to .all.
            let filter: PhotoKitFilter
            if case .photosFilter(let f) = librarySelection { filter = f }
            else { filter = .all }
            loadPhotos(filter: filter)
        }
    }

    /// Open the FullImage editor for a `.localOnly` cell selected from the
    /// merged cloud timeline. These are PhotoKit photos that haven't been
    /// uploaded yet, so there is no `SearchAsset` to route through
    /// `openCloudAsset` — instead, build a PhotoKit-backed AssetRef from
    /// the asset's local identifier and open it in the editor with
    /// session-local edits (matches the regular PhotoKit-filter flow).
    @MainActor
    func openLocalPhotoKitAsset(_ ref: ImageRef) {
        Task { @MainActor in
            do {
                let source = try PhotoKitSource()
                let displayName = ref.displayName
                let ext = (displayName as NSString).pathExtension.lowercased()
                let assetRef = AssetRef(
                    displayName: displayName,
                    hintExtension: ext.isEmpty ? nil : ext,
                    stableID: ref.id,
                    bytesProvider: { [source, ref] in
                        try await source.rawBytes(for: ref)
                    }
                )
                if sessions[assetRef.id] == nil {
                    let session = EditSession(asset: assetRef)
                    sessions[assetRef.id] = session
                    Task { await session.loadSidecar() }
                }
                browseVM.loadSingleCloudAsset(assetRef)
                mode = .fullImage
            } catch {
                browseVM.loadError = error
            }
        }
    }

    // MARK: - SMB

    @MainActor
    func connectSMB(credentials: SMBSource.Credentials) {
        Task { @MainActor in
            try? await SMBCredentialStore.shared.save(credentials)

            let source = SMBSource()
            do {
                try await source.connect(credentials: credentials, remotePath: "/")
                await browseVM.loadSource(source)
                let share = SMBCredentialStore.SavedShare(
                    host: credentials.host,
                    share: credentials.share,
                    username: credentials.username
                )
                SourceSelectionStore.save(.smb(share))
                librarySelection = .smbShare(share)
                libraryTitle = "\(credentials.host) / \(credentials.share)"
                mode = .browse
                currentRootBookmark = nil
            } catch {
                browseVM.loadError = error
            }
        }
    }

    @MainActor
    func connectSavedSMB(_ share: SMBCredentialStore.SavedShare) {
        Task { @MainActor in
            if let creds = await SMBCredentialStore.shared.credentials(for: share) {
                connectSMB(credentials: creds)
            } else {
                // Keychain miss — re-prompt.
                showSMBSheet = true
            }
        }
    }
}
