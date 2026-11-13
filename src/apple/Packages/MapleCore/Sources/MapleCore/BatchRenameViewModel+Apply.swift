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
    if hasUnsafeExtension {
      applyResults = assets.map {
        BatchRenameApplyResult(
          id: $0.id, oldFilename: $0.fullFilename,
          outcome: .failed(Self.extensionSafetyError))
      }
      return
    }
    switch routing {
    case .unsupported(let reason):
      applyResults = assets.map {
        BatchRenameApplyResult(
          id: $0.id, oldFilename: $0.fullFilename, outcome: .failed(reason))
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
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .failed(item.error ?? "No rendered name.")))
        continue
      }
      guard candidateName != item.oldFilename else {
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .renamed(newFilename: candidateName)))
        continue
      }
      let newName = candidateName
      guard let url = asset.primaryURL else {
        results.append(
          BatchRenameApplyResult(
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
          companion: asset.stack?.localCompanionURL, mode: .move,
          collision: collision.localPolicy)
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .renamed(newFilename: (outcome.primaryPath as NSString).lastPathComponent)))
      } catch FileOperationError.destinationExists(let path)
        where StackCollisionAsk(stack: asset.stack).namesCompanion(path)
      {
        results.append(Self.companionTaken(asset, oldFilename: item.oldFilename, path: path))
      } catch FileOperationError.destinationExists where collision == .skip {
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .skipped(reason: "A file with that name already exists.")))
      } catch {
        results.append(
          BatchRenameApplyResult(
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
          id: $0.id, oldFilename: $0.fullFilename,
          outcome: .failed("SMB share is not connected."))
      }
    }
    var results: [BatchRenameApplyResult] = []
    results.reserveCapacity(assets.count)
    for (asset, item) in zip(assets, preview) {
      guard item.error == nil, let candidateName = item.newFilename else {
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .failed(item.error ?? "No rendered name.")))
        continue
      }
      guard candidateName != item.oldFilename else {
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .renamed(newFilename: candidateName)))
        continue
      }
      let newName = candidateName
      guard let ref = asset.smbMutationRef else {
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .failed("Missing SMB asset id.")))
        continue
      }
      do {
        let newPath: String
        if let stack = asset.stack, let companionRef = stack.smbCompanionRef {
          newPath = try await smbSource.renameAsset(
            ref, companion: companionRef, to: newName, collision: collision.localPolicy
          ).primary
        } else {
          newPath = try await smbSource.renameAsset(
            ref, to: newName, collision: collision.localPolicy)
        }
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .renamed(newFilename: (newPath as NSString).lastPathComponent)))
      } catch FileOperationError.destinationExists(let path)
        where StackCollisionAsk(stack: asset.stack).namesCompanion(path)
      {
        results.append(Self.companionTaken(asset, oldFilename: item.oldFilename, path: path))
      } catch FileOperationError.destinationExists where collision == .skip {
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .skipped(reason: "A file with that name already exists.")))
      } catch {
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: item.oldFilename,
            outcome: .failed(error.localizedDescription)))
      }
    }
    return results
  }

  /// One HTTP call for the whole batch — the server already applies
  /// sequentially (`batch-rename.ts`), so there is no per-asset loop here.
  /// A stack `refusedReplaceStacks` keeps out splits the batch around it,
  /// each part numbered from its first item's position so `{n}` matches
  /// the preview.
  func applyCloud() async -> [BatchRenameApplyResult] {
    guard let cloudCatalog else {
      return assets.map {
        BatchRenameApplyResult(
          id: $0.id, oldFilename: $0.fullFilename,
          outcome: .failed("Not connected to the server."))
      }
    }
    let ids = assets.map { $0.stableID }
    guard ids.contains(where: { $0 != nil }) else {
      return assets.map {
        BatchRenameApplyResult(
          id: $0.id, oldFilename: $0.fullFilename,
          outcome: .failed("This photo hasn't finished indexing on the server yet."))
      }
    }
    let refused = await refusedReplaceStacks(cloudCatalog)
    let sent = zip(assets, ids).compactMap { asset, id in id.map { ($0, refused[asset.id] == nil) }
    }
    var items: [CloudBatchRenameResultItem] = []
    var failures: [String: String] = [:]
    var position = 0
    while position < sent.count {
      guard sent[position].1 else {
        position += 1
        continue
      }
      let start = position
      while position < sent.count, sent[position].1 { position += 1 }
      let run = sent[start..<position].map(\.0)
      do {
        items += try await cloudCatalog.batchRename(
          ids: run, template: template, sequenceStart: sequenceStart + start,
          sequencePadWidth: sequencePadWidth, collision: collision.apiValue
        ).results
      } catch {
        for id in run { failures[id] = error.localizedDescription }
      }
    }
    let byID = indexByIDTolerantOfDuplicates(items, id: \.id)
    var results: [BatchRenameApplyResult] = []
    for (asset, stableID) in zip(assets, ids) {
      let old = asset.fullFilename
      if let result = refused[asset.id] {
        results.append(result)
        continue
      }
      guard let stableID else {
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: old,
            outcome: .failed("This photo hasn't finished indexing on the server yet.")))
        continue
      }
      if let failure = failures[stableID] {
        results.append(
          BatchRenameApplyResult(id: asset.id, oldFilename: old, outcome: .failed(failure)))
        continue
      }
      guard let item = byID[stableID] else {
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: old,
            outcome: .failed("No result returned by the server.")))
        continue
      }
      switch item.kind {
      case "relocated":
        results.append(
          await renamedWithCompanion(asset, as: item.newFilename ?? old, catalog: cloudCatalog))
      case "skipped":
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: old,
            outcome: .skipped(reason: item.reason ?? "collision")))
      default:
        results.append(
          BatchRenameApplyResult(
            id: asset.id, oldFilename: old,
            outcome: .failed(item.error ?? "Rename failed (\(item.kind)).")))
      }
    }
    return results
  }

  /// Under Replace the server overwrites an unindexed file at a RAW's new name and deletes it as
  /// soon as that RAW commits, so a JPEG that then could not follow would lose that file even
  /// though the RAW is put back. A stack goes into a Replace batch only when its JPEG's new name
  /// is free on the server and no other item in this batch takes it; any other stack is reported
  /// here, by asset, with both files left as they were.
  private func refusedReplaceStacks(_ catalog: RemoteCatalog) async
    -> [AssetRef.ID: BatchRenameApplyResult]
  {
    guard collision == .replace else { return [:] }
    let rows = zip(assets, preview).compactMap { asset, item -> (AssetRef, String)? in
      guard item.error == nil, let name = item.newFilename else { return nil }
      return (asset, name)
    }
    func claim(_ asset: AssetRef, _ name: String) -> String {
      let folder = ((asset.catalog?.absPath ?? "") as NSString).deletingLastPathComponent
      return "\(folder)/\(name)".lowercased()
    }
    var claims: [String: Int] = [:]
    for (asset, name) in rows {
      claims[claim(asset, name), default: 0] += 1
      if let stack = asset.stack {
        claims[claim(asset, stack.companionFilename(forPrimaryFilename: name)), default: 0] += 1
      }
    }
    var refused: [AssetRef.ID: BatchRenameApplyResult] = [:]
    for (asset, name) in rows {
      guard let stack = asset.stack, name != asset.fullFilename else { continue }
      let jpegName = stack.companionFilename(forPrimaryFilename: name)
      do {
        if claims[claim(asset, jpegName), default: 0] > 1 {
          throw FileOperationError.destinationExists(jpegName)
        }
        guard let folderID = asset.catalog?.folderID else {
          throw FileOperationError.unsupportedSource("this photo's server library is unknown")
        }
        try await catalog.requireCompanionRenameFree(
          of: stack, toMatch: name, libraryFolderID: folderID)
      } catch FileOperationError.destinationExists(let path) {
        refused[asset.id] = Self.companionTaken(asset, oldFilename: asset.fullFilename, path: path)
      } catch {
        refused[asset.id] = BatchRenameApplyResult(
          id: asset.id, oldFilename: asset.fullFilename,
          outcome: .skipped(
            reason: "\(Self.companionFailureReason(error)) Both files keep their names."))
      }
    }
    return refused
  }

  /// A stacked RAW's JPEG follows the batch: the server renamed the RAW, so the JPEG takes its new
  /// stem here (#5050). A JPEG that cannot follow puts the RAW back under its old name, so the
  /// result reports what is on disk.
  private func renamedWithCompanion(
    _ asset: AssetRef, as newFilename: String, catalog: RemoteCatalog
  ) async -> BatchRenameApplyResult {
    let renamed = BatchRenameApplyResult(
      id: asset.id, oldFilename: asset.fullFilename, outcome: .renamed(newFilename: newFilename))
    guard let stack = asset.stack, newFilename != asset.fullFilename else { return renamed }
    do {
      try await catalog.renameCompanion(of: stack, toMatch: newFilename)
      return renamed
    } catch {
      let restored: Bool
      if let assetID = asset.stableID,
        case .ok = try? await catalog.renameAsset(
          assetID: assetID, newFilename: asset.fullFilename)
      {
        restored = true
      } else {
        restored = false
      }
      let reason = Self.companionFailureReason(error)
      return BatchRenameApplyResult(
        id: asset.id, oldFilename: asset.fullFilename,
        outcome: restored
          ? .skipped(reason: "\(reason) The RAW keeps its name.")
          : .failed(
            "Renamed the RAW to \(newFilename), but \(reason.prefix(1).lowercased() + reason.dropFirst()) Rename it back by hand."
          ))
    }
  }

  private static func companionFailureReason(_ error: Error) -> String {
    if case FileOperationError.destinationExists(let name) = error {
      return "Its JPEG could not follow: \((name as NSString).lastPathComponent) already exists."
    }
    return "Its JPEG could not follow: \(error.localizedDescription)."
  }

  /// The JPEG's new name is taken: the pair was left as it was, whatever the RAW's policy said,
  /// since the RAW's collision choice never replaces an unrelated JPEG (#5050).
  static func companionTaken(_ asset: AssetRef, oldFilename: String, path: String)
    -> BatchRenameApplyResult
  {
    BatchRenameApplyResult(
      id: asset.id, oldFilename: oldFilename,
      outcome: .skipped(
        reason:
          "\((path as NSString).lastPathComponent) already exists, so this RAW and its JPEG kept their names."
      ))
  }
}
