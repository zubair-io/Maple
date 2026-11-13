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
  /// this after the server has renamed the RAWs. The JPEG is addressed by the location the listing
  /// reported, so a JPEG the server holds at several locations renames that copy.
  public func renameCompanion(of stack: RawJpegStack, toMatch primaryFilename: String) async throws
  {
    let companionName = stack.companionFilename(forPrimaryFilename: primaryFilename)
    switch try await renameAsset(
      assetID: companionID(of: stack), newFilename: companionName,
      sourceAddress: companionAddress(of: stack))
    {
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
  /// its name is taken, before either file moves. With `companionCollision: .replace` the file at
  /// the JPEG's name goes to the server's Trash first (`trashDisplacedCompanion`). Keep Both asks
  /// for a RAW name whose stem is free in `libraryFolderID`'s `destinationPath` for the RAW, the
  /// JPEG and their sidecar: the server's own keep-both looks at the RAW alone. `restore` is where
  /// a move puts the RAW back when the JPEG cannot follow; the RAW is addressed there by the
  /// location the move gave it, not its old `sourceAddress`.
  public func relocateAsset(
    assetID: String, mode: RelocateMode, collision: CollisionPolicy, destinationPath: String,
    sourceAddress: String?, stack: RawJpegStack, libraryFolderID: String,
    restore: (path: String, filename: String), companionCollision: CollisionPolicy = .fail
  ) async throws -> RelocateAssetResult {
    let companion = try companionID(of: stack)
    if collision != .autoSuffix {
      if companionCollision == .replace {
        try await trashDisplacedCompanion(
          stack, libraryFolderID: libraryFolderID, destinationPath: destinationPath)
      } else {
        try await requireCompanionNameFree(
          stack, libraryFolderID: libraryFolderID, destinationPath: destinationPath)
      }
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

  /// Sends the file at the JPEG's name in `destinationPath`, which the JPEG's own prompt chose to
  /// replace, to the server's Trash before the RAW moves. While it sits there it shares the
  /// destination's sidecar stem, so the server will not let the RAW replace that sidecar
  /// (`relocate-sidecar-plan.ts`, #4692) and the pair cannot land, and a sidecar the RAW's Replace
  /// left behind would pass to the JPEG. In the Trash it stays recoverable, where a Replace would
  /// delete it. A file the server indexes as a photo of its own is refused before anything moves:
  /// trashing that asset would trash every copy of it.
  private func trashDisplacedCompanion(
    _ stack: RawJpegStack, libraryFolderID: String, destinationPath: String
  ) async throws {
    let name = stack.companion.name
    let path = destinationPath.isEmpty ? name : "\(destinationPath)/\(name)"
    if let address = companionAddress(of: stack), let colon = address.firstIndex(of: ":"),
      address[address.index(after: colon)...].caseInsensitiveCompare(path) == .orderedSame
    {
      return  // the JPEG itself
    }
    guard try await statFile(folderID: libraryFolderID, relativePath: path) != nil else { return }
    if case .indexedAsset = try await deleteFile(folderID: libraryFolderID, relativePath: path) {
      throw FileOperationError.invalidDestination(
        "\(name) in the destination is a photo of its own on the server. Move or trash it there"
          + " first: replacing it along with the RAW would leave the RAW and that photo sharing one"
          + " sidecar.")
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
  /// refuses brings the trashed RAW back, so the tile is never left half trashed. The server picks
  /// each asset's trash name on its own, so with a file of the pair's stem already in the Trash of
  /// the library `libraryFolderID` the RAW and the JPEG would land under different stems and the
  /// JPEG's sidecar beside the older photo: that trash is refused before anything moves, until the
  /// server can trash a pair under one stem (#5930). The server's trash takes no location, so a
  /// JPEG it holds in several places is refused too: it would trash whichever copy it picks.
  /// `primaryAbsPath` is the RAW's server path.
  public func deleteAsset(
    assetID: String, intent: DeleteAssetIntent, stack: RawJpegStack, libraryFolderID: String,
    primaryAbsPath: String
  ) async throws -> DeleteAssetResult {
    let companion = try companionID(of: stack)
    if intent == .trash {
      try await requireTrashStemFree(
        stack, libraryFolderID: libraryFolderID, primaryAbsPath: primaryAbsPath)
      try await requireOneCompanionLocation(stack, id: companion)
    }
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

  /// Throws `unsupportedSource` when the server holds the JPEG at more than one live location:
  /// `DELETE /api/assets/<id>` trashes the copy the server picks (`activeFileInfo`), which need
  /// not be the one listed beside the RAW, and both DELETEs would succeed with the pair split.
  private func requireOneCompanionLocation(_ stack: RawJpegStack, id: String) async throws {
    guard let asset = try await getAsset(assetID: id) else {
      throw FileOperationError.sourceMissing(stack.companion.name)
    }
    guard (asset.fileInfo ?? []).filter({ $0.deletedAt == nil }).count > 1 else { return }
    throw FileOperationError.unsupportedSource(
      "The server holds \(stack.companion.name) in more than one place and can't be told which"
        + " copy to trash, so it could trash a different copy and leave this one behind. Nothing"
        + " was trashed.")
  }

  /// Throws `destinationExists` when the library's `.maple/trash/<dir>` already holds the RAW's,
  /// the JPEG's or their sidecar's name, `<dir>` being the RAW's folder in the library (the
  /// server's `computeTrashPath`).
  private func requireTrashStemFree(
    _ stack: RawJpegStack, libraryFolderID: String, primaryAbsPath: String
  ) async throws {
    guard let root = try await listFolders().first(where: { $0.id == libraryFolderID }),
      let directory = Self.libraryDirectory(of: primaryAbsPath, root: root.path)
    else {
      throw FileOperationError.invalidDestination(
        "\(stack.primary.name) is no longer in a library this server lists.")
    }
    let trash = directory.isEmpty ? ".maple/trash" : ".maple/trash/\(directory)"
    let stem = (stack.primary.name as NSString).deletingPathExtension
    for name in [stack.primary.name, stack.companion.name, "\(stem).xmp"] {
      guard try await statFile(folderID: libraryFolderID, relativePath: "\(trash)/\(name)") != nil
      else { continue }
      throw FileOperationError.destinationExists(
        "the server's Trash already holds \(name). Restore or delete it there first: this RAW and"
          + " JPEG would otherwise be trashed under different names.")
    }
  }

  /// The folder holding `absPath`, relative to the library `root` and `/`-separated ("" at the
  /// root), or nil when `absPath` is not under `root`. A Windows-hosted server answers with
  /// backslashes.
  static func libraryDirectory(of absPath: String, root: String) -> String? {
    let separator: Character = root.contains("\\") ? "\\" : "/"
    let base = root.hasSuffix(String(separator)) ? String(root.dropLast()) : root
    guard let cut = absPath.lastIndex(of: separator) else { return nil }
    let folder = String(absPath[..<cut])
    if folder == base { return "" }
    guard folder.hasPrefix(base + String(separator)) else { return nil }
    return String(folder.dropFirst(base.count + 1)).replacingOccurrences(of: "\\", with: "/")
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
