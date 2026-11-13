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
    return address  // nil: the server resolves the asset by its id alone
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
  /// the JPEG's name goes to the server's Trash first (`trashDisplacedCompanion`), once a RAW with
  /// the detect-only policy is known to have a free name: the server has no way to bring that file
  /// back, so a RAW the server would skip must be asked about before it goes. Keep Both asks for a
  /// RAW name whose stem is free in `libraryFolderID`'s `destinationPath` for the RAW, the JPEG
  /// and their sidecar: the server's own keep-both looks at the RAW alone. `restore` is where a
  /// move puts the RAW back when the JPEG cannot follow; the RAW is addressed there by the location
  /// the move gave it, not its old `sourceAddress`.
  public func relocateAsset(
    assetID: String, mode: RelocateMode, collision: CollisionPolicy, destinationPath: String,
    sourceAddress: String?, stack: RawJpegStack, libraryFolderID: String,
    restore: (path: String, filename: String), companionCollision: CollisionPolicy = .fail
  ) async throws -> RelocateAssetResult {
    let companion = try companionID(of: stack)
    var displaced: String?
    if collision != .autoSuffix {
      if companionCollision == .replace {
        if collision == .fail,
          try await rawNameTaken(
            stack, sourceAddress: sourceAddress, libraryFolderID: libraryFolderID,
            destinationPath: destinationPath)
        {
          return .skipped(reason: "collision")
        }
        displaced = try await trashDisplacedCompanion(
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
    let primary: RelocateAssetResult
    do {
      primary = try await relocateAsset(
        assetID: assetID, mode: mode, collision: collision, destinationPath: destinationPath,
        destinationFilename: keepBothName == stack.primary.name ? nil : keepBothName,
        sourceAddress: sourceAddress)
    } catch {
      throw Self.noting(displaced, on: error)
    }
    guard case .ok(let moved) = primary else {
      guard displaced != nil else { return primary }
      throw Self.noting(displaced, on: Self.error(for: primary, name: stack.primary.name))
    }
    let companionName =
      moved.newFilename == stack.primary.name
      ? nil : stack.companionFilename(forPrimaryFilename: moved.newFilename)
    do {
      let result = try await relocateAsset(
        assetID: companion, mode: mode,
        collision: collision != .autoSuffix && companionCollision == .replace ? .replace : .fail,
        destinationPath: destinationPath, destinationFilename: companionName,
        sourceAddress: companionAddress(of: stack))
      if case .ok = result { return primary }
      if case .notFound = result { throw FileOperationError.sourceMissing(stack.companion.name) }
      throw Self.error(for: result, name: companionName ?? stack.companion.name)
    } catch {
      if mode == .move {
        _ = try? await relocateAsset(
          assetID: assetID, mode: .move, collision: .fail, destinationPath: restore.path,
          destinationFilename: restore.filename,
          sourceAddress: sourceAddress.flatMap { Self.address($0, movedTo: moved) })
      }
      throw Self.noting(displaced, on: error)
    }
  }

  /// The error a stack move reports for a relocate of the file `name` that did not land.
  private static func error(for result: RelocateAssetResult, name: String) -> FileOperationError {
    switch result {
    case .ok, .skipped: return .destinationExists(name)
    case .invalid(let message): return .invalidDestination(message)
    case .notFound: return .sourceMissing(name)
    }
  }

  /// `error`, saying where the file Replace sent to the server's Trash for the JPEG is when the
  /// pair then did not land. The server cannot put a file it does not index back (its Trash route
  /// for such a file has no restore, and its relocate refuses `.maple` paths), so it stays there
  /// until the user restores it by hand (#5929).
  private static func noting(_ displaced: String?, on error: Error) -> Error {
    guard let displaced else { return error }
    return FileOperationError.underlying(
      "\(error.localizedDescription) \(displaced) had already gone to the server's Trash to make"
        + " room for the JPEG; it is in the library's .maple/trash folder.")
  }

  /// Whether a file or folder other than the RAW itself holds the RAW's name in `destinationPath`.
  private func rawNameTaken(
    _ stack: RawJpegStack, sourceAddress: String?, libraryFolderID: String,
    destinationPath: String
  ) async throws -> Bool {
    let name = stack.primary.name
    let path = destinationPath.isEmpty ? name : "\(destinationPath)/\(name)"
    if let sourceAddress,
      Self.relativePath(ofAddress: sourceAddress)?.caseInsensitiveCompare(path) == .orderedSame
    {
      return false
    }
    return try await occupant(folderID: libraryFolderID, relativePath: path) != .free
  }

  /// The library-relative path in a `<library>:<relative path>` address.
  private static func relativePath(ofAddress address: String) -> String? {
    guard let colon = address.firstIndex(of: ":") else { return nil }
    return String(address[address.index(after: colon)...])
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
    if try await occupant(folderID: libraryFolderID, relativePath: path) != .free {
      throw FileOperationError.destinationExists(name)
    }
  }

  /// Sends the file at the JPEG's name in `destinationPath`, which the JPEG's own prompt chose to
  /// replace, to the server's Trash before the RAW moves, and returns its name (nil when nothing
  /// was displaced). While it sits there it shares the destination's sidecar stem, so the server
  /// will not let the RAW replace that sidecar (`relocate-sidecar-plan.ts`, #4692) and the pair
  /// cannot land, and a sidecar the RAW's Replace left behind would pass to the JPEG. In the Trash
  /// it stays recoverable, where a Replace would delete it. The server refuses to trash an indexed
  /// file this way, which leaves the JPEG itself alone (a hit carries no `address` to compare paths
  /// by, only its `id`), and a photo of its own there is refused before anything moves: trashing
  /// that asset would trash every copy of it.
  private func trashDisplacedCompanion(
    _ stack: RawJpegStack, libraryFolderID: String, destinationPath: String
  ) async throws -> String? {
    let name = stack.companion.name
    let path = destinationPath.isEmpty ? name : "\(destinationPath)/\(name)"

    switch try await occupant(folderID: libraryFolderID, relativePath: path) {
    case .free: return nil
    case .notAFile:
      throw FileOperationError.invalidDestination(
        "\(name) in the destination is a folder, not a file, so the JPEG can't replace it. Rename"
          + " or move that folder first.")
    case .file: break
    }
    guard
      case .indexedAsset(let indexed) = try await deleteFile(
        folderID: libraryFolderID, relativePath: path)
    else { return name }
    if try indexed == companionID(of: stack) { return nil }  // the JPEG itself
    throw FileOperationError.invalidDestination(
      "\(name) in the destination is a photo of its own on the server. Move or trash it there"
        + " first: replacing it along with the RAW would leave the RAW and that photo sharing one"
        + " sidecar.")
  }

  /// Throws before a batch rename under Replace sends the RAW: the server deletes what the RAW's
  /// Replace displaced as soon as it commits, so a JPEG that then could not follow would lose that
  /// file even though the RAW is put back. Throws the companion's error when the JPEG has no server
  /// location yet, and `destinationExists` naming the JPEG's new name when a file or folder in the
  /// library `libraryFolderID` holds it beside the JPEG. A hit's JPEG carries no address, so its
  /// folder is the RAW's, from `primaryAddress`.
  public func requireCompanionRenameFree(
    of stack: RawJpegStack, toMatch primaryFilename: String, libraryFolderID: String,
    primaryAddress: String?
  ) async throws {
    _ = try companionID(of: stack)
    guard let beside = (companionAddress(of: stack) ?? primaryAddress),
      let besidePath = Self.relativePath(ofAddress: beside)
    else {
      throw FileOperationError.unsupportedSource(
        "the server didn't say which folder \(stack.companion.name) is in")
    }
    let directory = (besidePath as NSString).deletingLastPathComponent
    func inDirectory(_ name: String) -> String { directory.isEmpty ? name : "\(directory)/\(name)" }
    let name = stack.companionFilename(forPrimaryFilename: primaryFilename)
    let path = inDirectory(name)
    if path.caseInsensitiveCompare(inDirectory(stack.companion.name)) == .orderedSame { return }
    if try await occupant(folderID: libraryFolderID, relativePath: path) != .free {
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
      return try await occupant(folderID: libraryFolderID, relativePath: path) != .free
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
  /// RAW or JPEG it holds in several places is refused too: it would trash whichever copy it picks.
  /// `primaryAbsPath` is the RAW's server path.
  public func deleteAsset(
    assetID: String, intent: DeleteAssetIntent, stack: RawJpegStack, libraryFolderID: String,
    primaryAbsPath: String
  ) async throws -> DeleteAssetResult {
    let companion = try companionID(of: stack)
    if intent == .trash {
      try await requireTrashStemFree(
        stack, libraryFolderID: libraryFolderID, primaryAbsPath: primaryAbsPath)
      try await requireOneLocation(assetID: companion, name: stack.companion.name)
      try await requireOneLocation(assetID: assetID, name: stack.primary.name)
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

  /// Throws `unsupportedSource` when the server holds the RAW or JPEG `name` at more than one live
  /// location: `DELETE /api/assets/<id>` trashes the copy the server picks (`activeFileInfo`),
  /// which need not be the one listed in this folder, and both DELETEs would succeed with the
  /// listed pair split.
  private func requireOneLocation(assetID: String, name: String) async throws {
    guard let asset = try await getAsset(assetID: assetID) else {
      throw FileOperationError.sourceMissing(name)
    }
    guard (asset.fileInfo ?? []).filter({ $0.deletedAt == nil }).count > 1 else { return }
    throw FileOperationError.unsupportedSource(
      "The server holds \(name) in more than one place and can't be told which"
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
      guard
        try await occupant(folderID: libraryFolderID, relativePath: "\(trash)/\(name)") != .free
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
        address: address.map {
          Self.replacingLastComponent(of: $0, with: companionName, separators: ["/", ":"])
        },
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
