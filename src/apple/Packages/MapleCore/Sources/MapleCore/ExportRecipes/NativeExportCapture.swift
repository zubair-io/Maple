import Foundation

public enum NativeExportCapture {
  /// Capture authored edits without flushing or changing the user's sidecar.
  @MainActor
  public static func target(session: EditSession, index: UInt64, workspace: URL, jobID: UUID)
    async throws -> NativeExportTarget
  {
    try await captureTarget(
      session: session, index: index, workspace: workspace, jobID: jobID, artifacts: nil)
  }

  @MainActor
  private static func captureTarget(
    session: EditSession, index: UInt64, workspace: URL,
    jobID: UUID, artifacts: NativeExportArtifacts?
  ) async throws -> NativeExportTarget {
    let asset = session.asset
    guard !asset.isVideo, !asset.isAudio, !asset.isStub else {
      throw NativeExportError.message("Select available photos for export.")
    }
    if !session.hasLoadedSidecar { await session.loadSidecar() }
    guard session.hasLoadedSidecar else {
      throw session.sidecarError
        ?? NativeExportError.message(
          "Could not load this photo's edits. Reconnect its source and try again.")
    }
    let scope = asset.scopeParentURL ?? asset.primaryURL
    let granted = scope?.startAccessingSecurityScopedResource() ?? false
    defer { if granted { scope?.stopAccessingSecurityScopedResource() } }
    let frozenModel = session.model
    let frozenCulling = session.culling
    let source: NativeExportSource
    if let url = asset.primaryURL {
      let scope = asset.scopeParentURL ?? url
      let accessing = scope.startAccessingSecurityScopedResource()
      defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
      source = try await BlockingWork.run {
        let absolute = url.standardizedFileURL
        let parent = scope.standardizedFileURL
        let relative =
          absolute == parent ? "" : String(absolute.path.dropFirst(parent.path.count + 1))
        guard absolute == parent || absolute.path.hasPrefix(parent.path + "/"),
          let hash = try NativeExportStorage.hash(absolute)
        else {
          throw NativeExportError.message(
            "The original is unavailable under its folder grant. Choose the original folder again.")
        }
        return NativeExportSource(
          id: asset.id.uuidString, url: absolute, scopeURL: parent,
          bookmark: try NativeExportAccess.bookmark(parent), relativePath: relative,
          originalHash: hash, identity: try NativeExportStorage.identity(absolute),
          ownedDirectory: nil)
      }
    } else {
      guard let provider = asset.bytesProvider else {
        throw NativeExportError.message(
          "This photo's source cannot provide original bytes. Reconnect it and try again.")
      }
      let bytes = try await provider()
      try Task.checkCancellation()
      source = try await BlockingWork.run {
        let directory = workspace.appendingPathComponent(
          "Jobs/\(jobID.uuidString)/Sources", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let ext = asset.hintExtension ?? "raw"
        guard ext.allSatisfy({ $0.isLetter || $0.isNumber }), !ext.isEmpty else {
          throw NativeExportError.message("The source file type is invalid.")
        }
        let url = directory.appendingPathComponent(asset.id.uuidString + "." + ext)
        if let artifacts {
          try artifacts.write(bytes, to: url)
        } else {
          try bytes.write(to: url, options: .withoutOverwriting)
        }
        guard let hash = try NativeExportStorage.hash(url) else {
          throw NativeExportError.message("Could not capture original bytes.")
        }
        return NativeExportSource(
          id: asset.id.uuidString, url: url, scopeURL: nil, bookmark: nil, relativePath: nil,
          originalHash: hash, identity: try NativeExportStorage.identity(url), ownedDirectory: jobID
        )
      }
    }
    let xmp = try XMPSerializer.serialize(model: frozenModel, culling: frozenCulling)
    let capturedAt = try await BlockingWork.run {
      let dates = ImageMetadataReader.readRawCaptureDateStrings(from: source.url)
      return dates.dateTimeOriginal ?? dates.createDate
    }
    return NativeExportTarget(
      source: source, stem: (asset.displayName as NSString).deletingPathExtension, xmp: xmp,
      capturedAt: capturedAt, index: index)
  }

  @MainActor
  public static func record(
    sessions: [EditSession], recipe: ExportRecipe, destination: URL, workspace: URL,
    bundle: Bundle = .main
  ) async throws -> NativeExportRecord {
    guard !sessions.isEmpty, sessions.count <= 2000,
      Set(sessions.map { $0.asset.id }).count == sessions.count
    else {
      throw NativeExportError.message("Select 1–2,000 different photos for export.")
    }
    try NativeExportRecipeBridge.validate(recipe)
    let id = UUID()
    let artifacts = try await BlockingWork.run {
      try NativeExportArtifacts(workspace: workspace, id: id)
    }
    do {
      var targets: [NativeExportTarget] = []
      var films = Set<String>()
      for (index, session) in sessions.enumerated() {
        let target = try await captureTarget(
          session: session, index: UInt64(index), workspace: workspace, jobID: id,
          artifacts: artifacts)
        targets.append(target)
        let model = try XMPParser.parse(data: Data(target.xmp.utf8)).0
        if !model.filmLook.isEmpty && model.filmStrength > 0 { films.insert(model.filmLook) }
      }
      let film = try await captureFilms(
        ids: films, workspace: workspace, jobID: id, bundle: bundle, artifacts: artifacts)
      let bookmark = try await BlockingWork.run { try NativeExportAccess.bookmark(destination) }
      return NativeExportRecord(
        version: 1, id: id, recipe: recipe, destinationBookmark: bookmark,
        originals: targets.map(\.source), filmDirectory: film.directory, filmHashes: film.hashes,
        items: targets.map { NativeExportItem(target: $0) }, ownedJob: artifacts.snapshot())
    } catch {
      let failure = error
      do {
        let snapshot = artifacts.snapshot()
        try await BlockingWork.run {
          try NativeExportArtifacts.remove(snapshot, workspace: workspace)
        }
      } catch {
        throw NativeExportError.message(
          "\(NativeExportStorage.failure(failure)) Private capture cleanup could not be verified; its files were preserved for review. \(NativeExportStorage.failure(error))"
        )
      }
      throw failure
    }
  }

  public static func captureFilms(
    ids: Set<String>, workspace: URL, jobID: UUID, bundle: Bundle = .main
  ) async throws -> (directory: URL?, hashes: [String: String]) {
    try await captureFilms(
      ids: ids, workspace: workspace, jobID: jobID, bundle: bundle, artifacts: nil)
  }

  private static func captureFilms(
    ids: Set<String>, workspace: URL, jobID: UUID, bundle: Bundle,
    artifacts: NativeExportArtifacts?
  ) async throws -> (directory: URL?, hashes: [String: String]) {
    if ids.isEmpty { return (nil, [:]) }
    return try await BlockingWork.run {
      let directory = workspace.appendingPathComponent(
        "Jobs/\(jobID.uuidString)/Film", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      var hashes: [String: String] = [:]
      for id in ids {
        guard
          id.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }),
          let source = bundle.url(forResource: id, withExtension: "mlut", subdirectory: "film-luts")
        else {
          throw NativeExportError.message(
            "The selected film look is unavailable. Restore it or choose another look before exporting."
          )
        }
        let name = id + ".mlut"
        let destination = directory.appendingPathComponent(name)
        let bytes = try Data(contentsOf: source)
        if let artifacts {
          try artifacts.write(bytes, to: destination)
        } else {
          try bytes.write(to: destination, options: .withoutOverwriting)
        }
        hashes[name] = try NativeExportStorage.hash(destination)
      }
      return (directory, hashes)
    }
  }
}
