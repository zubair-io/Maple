import Foundation

/// A stacked RAW+JPEG tile on a server library (#5050): the RAW's rename, move and trash carry the
/// JPEG's asset with it, addressed by the `id` and `address` the folder listing reported for the
/// companion (docs/api.md "RAW+JPEG stacks"). The server relocates one asset at a time, so the
/// pair is two calls. The RAW's collision choice never reaches the JPEG: the JPEG replaces an
/// occupant only when the caller passes `companionCollision: .replace` after a prompt that named
/// it, and a JPEG that cannot follow puts the RAW back.
extension RemoteCatalog {
  private func companionID(of stack: RawJpegStack) throws -> String {
    guard case .cloud(_, _, let id?) = stack.location else {
      throw FileOperationError.unsupportedSource(
        "The JPEG in this stack hasn't finished indexing on the server yet — try again once it has."
      )
    }
    return id
  }

  private func companionAddress(of stack: RawJpegStack) -> String? {
    guard case .cloud(let address, _, _) = stack.location else { return nil }
    return address
  }

  /// Rename the RAW to `newFilename` and the JPEG to the same stem.
  public func renameAsset(
    assetID: String, newFilename: String, stack: RawJpegStack
  ) async throws -> RenameAssetResult {
    _ = try companionID(of: stack)
    let primary = try await renameAsset(assetID: assetID, newFilename: newFilename)
    guard case .ok(let renamed) = primary else { return primary }
    do {
      try await renameCompanion(of: stack, toMatch: renamed.newFilename)
      return primary
    } catch {
      _ = try? await renameAsset(assetID: assetID, newFilename: stack.primary.name)
      throw error
    }
  }

  /// Rename the JPEG to the stem of its RAW's new name `primaryFilename`. The batch rename calls
  /// this after the server has renamed the RAWs.
  public func renameCompanion(of stack: RawJpegStack, toMatch primaryFilename: String) async throws
  {
    let companionName = stack.companionFilename(forPrimaryFilename: primaryFilename)
    switch try await renameAsset(assetID: companionID(of: stack), newFilename: companionName) {
    case .ok:
      return
    case .skipped:
      throw FileOperationError.destinationExists(companionName)
    case .invalid(let message):
      throw FileOperationError.invalidName(message)
    case .notFound:
      throw FileOperationError.sourceMissing(stack.companion.name)
    }
  }

  /// Move or copy the RAW, then the JPEG under the RAW's final stem. `collision` is the RAW's
  /// policy; the JPEG uses `companionCollision` and throws `destinationExists` naming the JPEG when
  /// its name is taken, before either file moves. Keep Both asks for a RAW name whose stem is free
  /// in `libraryFolderID`'s `destinationPath` for the RAW, the JPEG and their sidecar: the server's
  /// own keep-both looks at the RAW alone. `restore` is where a move puts the RAW back when the
  /// JPEG cannot follow; the RAW is addressed there by the location the move gave it, not its old
  /// `sourceAddress`.
  public func relocateAsset(
    assetID: String, mode: RelocateMode, collision: CollisionPolicy, destinationPath: String,
    sourceAddress: String?, stack: RawJpegStack, libraryFolderID: String,
    restore: (path: String, filename: String), companionCollision: CollisionPolicy = .fail
  ) async throws -> RelocateAssetResult {
    let companion = try companionID(of: stack)
    if collision != .autoSuffix, companionCollision != .replace {
      try await requireCompanionNameFree(
        stack, libraryFolderID: libraryFolderID, destinationPath: destinationPath)
    }
    let keepBothName =
      collision == .autoSuffix
      ? try await stackFilenameFreeForBoth(
        stack, libraryFolderID: libraryFolderID, destinationPath: destinationPath) : nil
    let primary = try await relocateAsset(
      assetID: assetID, mode: mode, collision: collision, destinationPath: destinationPath,
      destinationFilename: keepBothName == stack.primary.name ? nil : keepBothName,
      sourceAddress: sourceAddress)
    guard case .ok(let moved) = primary else { return primary }
    let companionName =
      moved.newFilename == stack.primary.name
      ? nil : stack.companionFilename(forPrimaryFilename: moved.newFilename)
    do {
      switch try await relocateAsset(
        assetID: companion, mode: mode,
        collision: collision != .autoSuffix && companionCollision == .replace ? .replace : .fail,
        destinationPath: destinationPath, destinationFilename: companionName,
        sourceAddress: companionAddress(of: stack))
      {
      case .ok:
        return primary
      case .skipped:
        throw FileOperationError.destinationExists(companionName ?? stack.companion.name)
      case .invalid(let message):
        throw FileOperationError.invalidDestination(message)
      case .notFound:
        throw FileOperationError.sourceMissing(stack.companion.name)
      }
    } catch {
      if mode == .move {
        _ = try? await relocateAsset(
          assetID: assetID, mode: .move, collision: .fail, destinationPath: restore.path,
          destinationFilename: restore.filename,
          sourceAddress: sourceAddress.flatMap { Self.address($0, movedTo: moved) })
      }
      throw error
    }
  }

  /// Throws `destinationExists` naming the JPEG when another file holds its name in
  /// `destinationPath`. Asked before the RAW moves: the server deletes what a Replace displaced as
  /// soon as that one asset commits, so a RAW that replaced an unindexed file ahead of a JPEG that
  /// then could not follow would lose the file it replaced, even though the RAW is put back.
  private func requireCompanionNameFree(
    _ stack: RawJpegStack, libraryFolderID: String, destinationPath: String
  ) async throws {
    let name = stack.companion.name
    let path = destinationPath.isEmpty ? name : "\(destinationPath)/\(name)"
    if try await statFile(folderID: libraryFolderID, relativePath: path) != nil {
      throw FileOperationError.destinationExists(name)
    }
  }

  /// The first RAW filename (`IMG_1.CR3`, `IMG_1.1.CR3`, …) whose stem names no file in
  /// `destinationPath`: not the RAW, not the JPEG, not their sidecar.
  private func stackFilenameFreeForBoth(
    _ stack: RawJpegStack, libraryFolderID: String, destinationPath: String
  ) async throws -> String {
    func taken(_ name: String) async throws -> Bool {
      let path = destinationPath.isEmpty ? name : "\(destinationPath)/\(name)"
      return try await statFile(folderID: libraryFolderID, relativePath: path) != nil
    }
    return try await CollisionResolver.pickFreePath(stack.primary.name) { candidate in
      if try await taken(candidate) { return true }
      if try await taken(stack.companionFilename(forPrimaryFilename: candidate)) { return true }
      return try await taken((candidate as NSString).deletingPathExtension + ".xmp")
    }
  }

  /// Trash the RAW, then the JPEG. A RAW the server refuses leaves both untouched; a JPEG it then
  /// refuses brings the trashed RAW back, so the tile is never left half trashed.
  public func deleteAsset(
    assetID: String, intent: DeleteAssetIntent, stack: RawJpegStack
  ) async throws -> DeleteAssetResult {
    let companion = try companionID(of: stack)
    let primary = try await deleteAsset(assetID: assetID, intent: intent)
    guard primary == .ok else { return primary }
    do {
      let companionResult = try await deleteAsset(assetID: companion, intent: intent)
      if companionResult != .ok, intent == .trash {
        _ = try? await restoreAsset(assetID: assetID, targetRelativePath: nil)
      }
      return companionResult
    } catch {
      if intent == .trash {
        _ = try? await restoreAsset(assetID: assetID, targetRelativePath: nil)
      }
      throw error
    }
  }

  /// `sourceAddress` (`<library>:<relative path>`) re-pointed at where a relocate put the file.
  static func address(_ sourceAddress: String, movedTo moved: RelocateAssetResponse) -> String? {
    guard let colon = sourceAddress.firstIndex(of: ":") else { return nil }
    let relative =
      moved.newPath.isEmpty ? moved.newFilename : "\(moved.newPath)/\(moved.newFilename)"
    return "\(sourceAddress[..<colon]):\(relative)"
  }
}

extension RawJpegStack {
  /// This stack after the server renamed its RAW: the JPEG sits beside the RAW under the same stem.
  /// A companion the listing carried no cloud location for (it cannot, here) stays as it was.
  public func relocatedCloud(afterRenameTo response: RenameAssetResponse) -> RawJpegStack {
    let companionName = companionFilename(forPrimaryFilename: response.newFilename)
    guard case .cloud(let address, let path, let id) = location else { return self }
    return relocated(
      primaryName: response.newFilename, companionName: companionName,
      location: .cloud(
        address: Self.replacingLastComponent(
          of: address, with: companionName, separators: ["/", ":"]),
        path: Self.replacingLastComponent(of: path, with: companionName, separators: ["/"]),
        id: id))
  }

  private static func replacingLastComponent(
    of value: String, with name: String, separators: Set<Character>
  ) -> String {
    guard let separator = value.lastIndex(where: separators.contains) else { return name }
    return "\(value[...separator])\(name)"
  }
}
