// BatchRenameViewModel+Apply.swift — `apply()` and its three per-source-kind
// paths (Filesystem / SMB / Cloud) for the Batch Rename sheet (#2641).
//
// Split out of BatchRenameViewModel.swift as a self-contained concern (see
// that file's header) — mirrors the Apple file-ops module's own
// `+Folders`/`+Trash`/`+CacheAndIndex` extension-file convention
// (`LocalFileOperations+Folders.swift` etc.) for grouping one type's
// cohesive-but-separable behavior into its own file.
//
// Applied SEQUENTIALLY — a shared-destination template can collide with
// itself mid-batch, not only with a pre-existing file, so each item must
// see the PREVIOUS item's already-applied result before it renders/resolves
// its own collision. Matches `library/batch-rename.ts`'s contract exactly
// (its doc comment explains why `Promise.all` is never used there; the same
// reasoning is why `applyFilesystem`/`applySMB` below are plain sequential
// `for` loops, never a `TaskGroup`). `applyCloud` is the one exception —
// ONE HTTP call for the whole batch, because the server already applies
// sequentially on its side.

import Foundation

extension BatchRenameViewModel {

    /// Refresh the preview once more (guards against a stale preview if the
    /// caller applies without having awaited a prior debounced refresh),
    /// then apply sequentially per routing. Always populates `applyResults`
    /// — including for `.unsupported` — so the sheet can show a per-file
    /// outcome list rather than a single pass/fail alert.
    ///
    /// `isApplying` is set BEFORE the first `await` (not after
    /// `refreshPreview()` returns) so a second tap that lands while the
    /// first call is still awaiting its own `refreshPreview()` sees the
    /// guard and is refused outright — this method, the guard check, and
    /// the `isApplying = true` that follows it all run synchronously on the
    /// main actor up to that first suspension point, so there is no window
    /// where two concurrent `apply()` calls could both pass the guard and
    /// interleave two rename passes over the same files on disk.
    public func apply() async {
        guard !isApplying else { return }
        isApplying = true
        defer { isApplying = false }
        await refreshPreview()
        switch routing {
        case .unsupported(let reason):
            applyResults = assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0), outcome: .failed(reason))
            }
        case .filesystem:
            applyResults = await applyFilesystem()
        case .smb:
            applyResults = await applySMB()
        case .cloud:
            applyResults = await applyCloud()
        }
    }

    func applyFilesystem() async -> [BatchRenameApplyResult] {
        var results: [BatchRenameApplyResult] = []
        results.reserveCapacity(assets.count)
        for (asset, item) in zip(assets, preview) {
            guard item.error == nil, let candidateName = item.newFilename else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed(item.error ?? "No rendered name.")))
                continue
            }
            guard candidateName != item.oldFilename else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .renamed(newFilename: candidateName)))
                continue
            }
            let newName = candidateName
            guard let url = asset.primaryURL else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed("This asset has no file on disk.")))
                continue
            }
            let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
            let accessing = scope.startAccessingSecurityScopedResource()
            defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
            do {
                let outcome = try await LocalFileOperations.relocate(
                    url, to: url.deletingLastPathComponent(), newBasename: newName,
                    mode: .move, collision: collision.localPolicy)
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .renamed(newFilename: (outcome.primaryPath as NSString).lastPathComponent)))
            } catch FileOperationError.destinationExists where collision == .skip {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .skipped(reason: "A file with that name already exists.")))
            } catch {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed(error.localizedDescription)))
            }
        }
        return results
    }

    func applySMB() async -> [BatchRenameApplyResult] {
        guard let smbSource else {
            return assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    outcome: .failed("SMB share is not connected."))
            }
        }
        var results: [BatchRenameApplyResult] = []
        results.reserveCapacity(assets.count)
        for (asset, item) in zip(assets, preview) {
            guard item.error == nil, let candidateName = item.newFilename else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed(item.error ?? "No rendered name.")))
                continue
            }
            guard candidateName != item.oldFilename else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .renamed(newFilename: candidateName)))
                continue
            }
            let newName = candidateName
            guard let mapleID = asset.stableID else {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed("Missing SMB asset id.")))
                continue
            }
            let ref = ImageRef(id: mapleID, displayName: asset.displayName, url: nil)
            do {
                let newPath = try await smbSource.renameAsset(
                    ref, to: newName, collision: collision.localPolicy)
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .renamed(newFilename: (newPath as NSString).lastPathComponent)))
            } catch FileOperationError.destinationExists where collision == .skip {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .skipped(reason: "A file with that name already exists.")))
            } catch {
                results.append(BatchRenameApplyResult(
                    id: asset.id, oldFilename: item.oldFilename,
                    outcome: .failed(error.localizedDescription)))
            }
        }
        return results
    }

    /// One HTTP call for the whole batch — the server already applies
    /// sequentially (`batch-rename.ts`), so there is no per-asset loop here.
    func applyCloud() async -> [BatchRenameApplyResult] {
        guard let cloudCatalog else {
            return assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    outcome: .failed("Not connected to the server."))
            }
        }
        let ids = assets.map { $0.stableID }
        let presentIDs = ids.compactMap { $0 }
        guard !presentIDs.isEmpty else {
            return assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    outcome: .failed("This photo hasn't finished indexing on the server yet."))
            }
        }
        do {
            let response = try await cloudCatalog.batchRename(
                ids: presentIDs, template: template, sequenceStart: sequenceStart,
                sequencePadWidth: sequencePadWidth, collision: collision.apiValue)
            let byID = indexByIDTolerantOfDuplicates(response.results, id: \.id)
            return zip(assets, ids).map { asset, stableID in
                let old = Self.fullFilename(asset)
                guard let stableID else {
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .failed("This photo hasn't finished indexing on the server yet."))
                }
                guard let item = byID[stableID] else {
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .failed("No result returned by the server."))
                }
                switch item.kind {
                case "relocated":
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .renamed(newFilename: item.newFilename ?? old))
                case "skipped":
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .skipped(reason: item.reason ?? "collision"))
                default:
                    return BatchRenameApplyResult(
                        id: asset.id, oldFilename: old,
                        outcome: .failed(item.error ?? "Rename failed (\(item.kind))."))
                }
            }
        } catch {
            return assets.map {
                BatchRenameApplyResult(
                    id: $0.id, oldFilename: Self.fullFilename($0),
                    outcome: .failed(error.localizedDescription))
            }
        }
    }
}
