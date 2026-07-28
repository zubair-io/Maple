// AppShell+TimelinePreviewAssets.swift — #2299.
//
// Root cause: the iPhone Timeline open path (`openAllSourcesTimeline`,
// `loadCloudLibrary`'s `.timeline` branch) both `browseVM.clear()` and never
// repopulate it. A Timeline cell tap pushes `LibraryDestination.preview(ref)`
// onto the Library tab's NavigationStack; `PhoneLibraryView`'s
// `.navigationDestination` used to resolve the sibling list as
// `browseVM.assets.contains(ref) ? browseVM.assets : [ref]` — with
// `browseVM` empty, every Timeline-opened Preview got a single-asset list
// (no swipe) and — combined with the `PreviewViewVM.thumbnailSource` fix in
// the same ticket — a PhotoKit-backed cell rendered blank.
//
// This file builds the REAL ordered sibling list straight from whichever
// Timeline VM is currently active (`AppShell.allSourcesTimelineVM` /
// `cloudTimelineVM`), using ONLY buckets that VM has already fetched — no
// new network fetch, no cross-bucket fetch-on-swipe. Each sibling's
// `AssetRef` is built LAZILY/CHEAPLY: enough to render a filmstrip thumbnail
// and its display-sized preview (id, displayName, stableID,
// `thumbnailProvenance`, and the lazy `bytesProvider` /
// `displayPreviewProvider` pair — both bound to the asset's OWN server, so a
// mixed multi-server list needs no ambient `ImageSource`; #2385) but no
// `EditSession`, no `CloudSidecarStore`, no download box. Those are created
// only for whichever asset actually becomes the shown Preview asset, via
// the EXISTING `ensureSession(for:)` (generalized in this
// same ticket to read `AssetRef.thumbnailProvenance`'s `.cloud(server:)`
// case) — wired from `PhoneLibraryView`'s `onSelectionChanged`.

import Foundation
import MapleCore

@MainActor
extension AppShell {
    /// The iPhone Preview swipe domain for whichever Timeline VM is active.
    /// Empty when neither VM is set — `.preview` was reached some other way
    /// (the local folder / PhotoKit-filter browse flow already threads
    /// `browseVM.assets`, which `PhoneLibraryView` prefers when it contains
    /// the pushed ref).
    func timelinePreviewAssets() -> [AssetRef] {
        if let vm = allSourcesTimelineVM {
            return timelinePreviewAssets(fromAllSources: vm)
        }
        if let vm = cloudTimelineVM {
            return timelinePreviewAssets(fromCloudTimeline: vm)
        }
        return []
    }

    /// Splice the asset the user actually TAPPED into its own sibling list.
    ///
    /// `prepareCloudSession` / `prepareLocalPhotoKitSession` mint a fresh
    /// `AssetRef.id` (a per-construction UUID) for the resolved asset —
    /// different from whatever `id` the lazily-built sibling for that SAME
    /// photo got in `timelinePreviewAssets()` above. Left unreconciled, the
    /// pushed `ref` would not be found BY ID in its own sibling list, and
    /// `PreviewViewVM.nextID`/`previousID` (which anchor on `currentID` via
    /// `firstIndex(of:)`) plus the filmstrip's active-highlight (`asset.id ==
    /// activeID`) would silently treat the shown asset as absent — no
    /// visible crash, just navigation and highlighting that never line up.
    /// Matching by `stableID` (the stable upstream id both the tapped ref and
    /// its list entry share — the cloud `SearchAsset.id` / PhotoKit
    /// `PHAsset.localIdentifier`) finds the right slot and replaces it with
    /// `ref` itself, so the REAL (already-sessioned) ref is what's actually
    /// in the array at that position. Falls back to a single-element list
    /// when no match is found (e.g. the tap raced a bucket reload) rather
    /// than risk a mismatched swipe domain.
    func timelinePreviewSiblingAssets(for ref: AssetRef) -> [AssetRef] {
        let siblings = timelinePreviewAssets()
        guard let stableID = ref.stableID,
              let index = siblings.firstIndex(where: { $0.stableID == stableID })
        else { return [ref] }
        var spliced = siblings
        spliced[index] = ref
        return spliced
    }

    // MARK: - Per-VM builders

    /// Unified cross-source Timeline: cells can belong to any connected
    /// server, so the owning server is resolved PER CELL via `vm.server(for:)`.
    private func timelinePreviewAssets(
        fromAllSources vm: AllSourcesTimelineViewModel
    ) -> [AssetRef] {
        var cloudSourcesByServer: [URL: CloudSource] = [:]
        var photoKitSource: PhotoKitSource?
        return vm.buckets.flatMap { bucket -> [AssetRef] in
            let key = AllSourcesTimelineViewModel.BucketKey(year: bucket.year, month: bucket.month)
            guard let cells = vm.mergedPagesByBucket[key] else { return [] }
            let absPathMap = Self.absPathMap(vm.pagesByBucket[key] ?? [])
            return cells.compactMap { cell in
                self.previewAssetRef(
                    for: cell, absPathMap: absPathMap,
                    server: { vm.server(for: $0) },
                    cloudSourcesByServer: &cloudSourcesByServer,
                    photoKitSource: &photoKitSource)
            }
        }
    }

    /// Single-library Timeline: one constant server for every cloud cell.
    /// Falls back to the cloud-only `pagesByBucket` page directly for a
    /// bucket that has no PhotoKit merge active (`photoKitMerge == nil`, or
    /// this particular month hasn't been merged yet) — mirrors
    /// `CloudTimelineView`'s own `hasContent`/render fallback.
    private func timelinePreviewAssets(
        fromCloudTimeline vm: CloudTimelineViewModel
    ) -> [AssetRef] {
        var cloudSourcesByServer: [URL: CloudSource] = [:]
        var photoKitSource: PhotoKitSource?
        return vm.buckets.flatMap { bucket -> [AssetRef] in
            let key = CloudTimelineViewModel.BucketKey(year: bucket.year, month: bucket.month)
            if let cells = vm.mergedPagesByBucket[key] {
                let absPathMap = Self.absPathMap(vm.pagesByBucket[key] ?? [])
                return cells.compactMap { cell in
                    self.previewAssetRef(
                        for: cell, absPathMap: absPathMap,
                        server: { _ in vm.server },
                        cloudSourcesByServer: &cloudSourcesByServer,
                        photoKitSource: &photoKitSource)
                }
            }
            return (vm.pagesByBucket[key] ?? []).map { asset in
                self.cloudAssetRef(asset, server: vm.server, cloudSourcesByServer: &cloudSourcesByServer)
            }
        }
    }

    // MARK: - Per-cell resolution

    private func previewAssetRef(
        for cell: MergedTimelineCell,
        absPathMap: [String: SearchAsset],
        server: (SearchAsset) -> URL?,
        cloudSourcesByServer: inout [URL: CloudSource],
        photoKitSource: inout PhotoKitSource?
    ) -> AssetRef? {
        switch cell {
        case .cloudOnly(let cloudRef), .synced(_, let cloudRef):
            let abs = Self.absPath(fromCloudID: cloudRef.id)
            guard let asset = absPathMap[abs], let owningServer = server(asset) else { return nil }
            return cloudAssetRef(asset, server: owningServer, cloudSourcesByServer: &cloudSourcesByServer)
        case .localOnly(let local):
            return photoKitAssetRef(local, photoKitSource: &photoKitSource)
        }
    }

    /// Lazy, display-only cloud `AssetRef`. No `EditSession`, no
    /// `CloudSidecarStore`, no `DownloadProgress`/download box — just a
    /// `bytesProvider` that resolves the asset's bytes on demand through a
    /// per-server `CloudSource`, reused (not rebuilt) across every cell on
    /// that server. `folderID`/`libraryPath` are irrelevant to the
    /// `rawBytes(for:)` call the closure makes below (it resolves the
    /// absolute path straight from `ref.id`), so one `CloudSource` per
    /// server serves every asset on it regardless of which library/folder
    /// the asset actually lives in.
    private func cloudAssetRef(
        _ asset: SearchAsset, server: URL, cloudSourcesByServer: inout [URL: CloudSource]
    ) -> AssetRef {
        let source: CloudSource
        if let existing = cloudSourcesByServer[server] {
            source = existing
        } else {
            source = CloudSource(
                server: LocalNetworkResolver.shared.effectiveURL(for: server),
                folderID: asset.folder_id,
                libraryPath: "",
                httpClient: makeAuthenticatedHTTPClient(server: server))
            cloudSourcesByServer[server] = source
        }
        let imageRef = ImageRef(id: asset.id, displayName: asset.filename, url: nil)
        return AssetRef(
            displayName: asset.filename,
            hintExtension: (asset.filename as NSString).pathExtension.lowercased(),
            stableID: asset.id,
            thumbnailProvenance: .cloud(server: server),
            // Same per-server `source` the byte fetch closes over, so the
            // 1280 px `/api/fs/preview` request lands on the server that
            // actually owns this asset (#2385). Without it the display tier
            // fell back to the Preview's one ambient `ImageSource` — the
            // `CloudSource` for whichever asset the user TAPPED — and a
            // sibling on a different server 404'd, never upgrading past its
            // grid thumbnail.
            displayPreviewProvider: { try await source.preview(for: imageRef) },
            bytesProvider: { try await source.rawBytes(for: imageRef) }
        )
    }

    /// Lazy, display-only PhotoKit `AssetRef`. One `PhotoKitSource` for the
    /// whole list build (constructing it is cheap — no PHAsset fetch happens
    /// until `rawBytes(for:)` is actually called); `nil` only if PhotoKit
    /// access has been revoked between the grid showing this cell and the
    /// tap that built this list, in which case the cell is dropped rather
    /// than crash on a throwing init.
    private func photoKitAssetRef(_ ref: ImageRef, photoKitSource: inout PhotoKitSource?) -> AssetRef? {
        if photoKitSource == nil {
            photoKitSource = try? PhotoKitSource()
        }
        guard let source = photoKitSource else { return nil }
        let ext = (ref.displayName as NSString).pathExtension.lowercased()
        return AssetRef(
            displayName: ref.displayName,
            hintExtension: ext.isEmpty ? nil : ext,
            stableID: ref.id,
            thumbnailProvenance: .photoKit,
            bytesProvider: { try await source.rawBytes(for: ref) }
        )
    }

    // MARK: - Helpers

    private static func absPathMap(_ assets: [SearchAsset]) -> [String: SearchAsset] {
        Dictionary(assets.map { ($0.abs_path, $0) }, uniquingKeysWith: { first, _ in first })
    }

    private static func absPath(fromCloudID id: String) -> String {
        id.hasPrefix("fs:") ? String(id.dropFirst(3)) : id
    }
}
