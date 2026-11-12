import Foundation

/// A stacked RAW+JPEG tile on a server library (#5050): the RAW's rename, move and trash carry the
/// JPEG's asset with it, addressed by the `id` and `address` the folder listing reported for the
/// companion (docs/api.md "RAW+JPEG stacks"). The server relocates one asset at a time, so the
/// pair is two calls; a JPEG that cannot follow puts the RAW back.
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

  /// Move or copy the RAW, then the JPEG under the RAW's final stem. `restore` is where a move
  /// puts the RAW back when the JPEG cannot follow.
  public func relocateAsset(
    assetID: String, mode: RelocateMode, collision: CollisionPolicy, destinationPath: String,
    sourceAddress: String?, stack: RawJpegStack, restore: (path: String, filename: String)
  ) async throws -> RelocateAssetResult {
    let companion = try companionID(of: stack)
    let primary = try await relocateAsset(
      assetID: assetID, mode: mode, collision: collision, destinationPath: destinationPath,
      sourceAddress: sourceAddress)
    guard case .ok(let moved) = primary else { return primary }
    let companionName =
      moved.newFilename == stack.primary.name
      ? nil : stack.companionFilename(forPrimaryFilename: moved.newFilename)
    do {
      switch try await relocateAsset(
        assetID: companion, mode: mode, collision: collision == .replace ? .replace : .fail,
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
          destinationFilename: restore.filename, sourceAddress: sourceAddress)
      }
      throw error
    }
  }

  /// Trash the JPEG, then the RAW: a RAW that then fails to trash is still whole.
  public func deleteAsset(
    assetID: String, intent: DeleteAssetIntent, stack: RawJpegStack
  ) async throws -> DeleteAssetResult {
    let companion = try companionID(of: stack)
    switch try await deleteAsset(assetID: companion, intent: intent) {
    case .ok:
      return try await deleteAsset(assetID: assetID, intent: intent)
    case let refused:
      return refused
    }
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
