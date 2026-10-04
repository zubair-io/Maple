import CoreGraphics
import CoreImage
import Foundation
import ImageIO
import MapleAgentWire

@MainActor
public protocol AgentBrowseDelegate: AnyObject {
  var browseAssets: [AssetRef] { get }
  var selectedAssetID: AssetRef.ID? { get }
  var activeCollectionName: String? { get }
  var activeFolderPath: String? { get }
  func session(for asset: AssetRef) -> EditSession?
  func ensureSession(for asset: AssetRef) -> EditSession
  func openPhoto(assetID: AssetRef.ID) async throws -> EditSession
  func updateCulling(
    assetID: AssetRef.ID,
    mutate: @Sendable @escaping (inout CullingState) -> Void
  ) async throws -> CullingState
}

@MainActor
enum AgentBrowseService {
  static func listPhotos(
    _ arguments: [String: JSONValue],
    delegate: (any AgentBrowseDelegate)?,
    activeSession: EditSession?
  ) async throws -> JSONValue {
    guard let delegate else {
      throw AgentError(
        code: "browse_unavailable",
        message: "Maple is not currently browsing a library or folder.")
    }
    let offset = try integer(arguments, key: "offset", range: 0...Int.max, defaultValue: 0)
    let limit = try integer(arguments, key: "limit", range: 1...100, defaultValue: 50)

    let allAssets = delegate.browseAssets
    let totalCount = allAssets.count
    let slice: ArraySlice<AssetRef>
    if offset < totalCount {
      slice = allAssets[offset..<(offset + min(limit, totalCount - offset))]
    } else {
      slice = []
    }

    let collectionName = delegate.activeCollectionName ?? "Library"
    let folderPath = delegate.activeFolderPath
    // Capture the page and its sessions before any I/O suspension. Folder
    // navigation cannot redirect an already-requested asset to another source.
    let snapshots = slice.map { asset in
      let existing =
        activeSession?.asset.id == asset.id ? activeSession : delegate.session(for: asset)
      let session = existing ?? (asset.primaryURL == nil ? delegate.ensureSession(for: asset) : nil)
      return (asset, session, session?.sidecarStore)
    }
    var photos: [JSONValue] = []
    for (asset, session, store) in snapshots {
      try Task.checkCancellation()
      var fields: [String: JSONValue] = [
        "id": .string(asset.id.uuidString),
        "name": .string(asset.displayName),
        "is_active": .bool(activeSession?.asset.id == asset.id),
      ]
      if let path = asset.primaryURL?.path { fields["path"] = .string(path) }
      let culling = await cullingState(for: asset, session: session, store: store)
      fields["rating"] = .int(culling.stars)
      fields["flag"] = .string(culling.flag.rawValue)
      if let color = culling.colorLabel { fields["color_label"] = .string(color.rawValue) }
      if let captureTime = await captureTimestamp(for: asset) {
        fields["capture_time"] = .string(captureTime)
      }
      photos.append(.object(fields))
    }

    var result: [String: JSONValue] = [
      "photos": .array(photos),
      "total_count": .int(totalCount),
      "offset": .int(offset),
      "limit": .int(limit),
      "collection_name": .string(collectionName),
    ]
    if let folderPath {
      result["folder_path"] = .string(folderPath)
    }
    return .object(result)
  }

  static func getThumbnails(
    _ arguments: [String: JSONValue],
    delegate: (any AgentBrowseDelegate)?,
    activeSession: EditSession?
  ) async throws -> AgentPayload {
    guard let delegate else {
      throw AgentError(
        code: "browse_unavailable",
        message: "Maple is not currently browsing a library or folder.")
    }
    guard let idsArray = arguments["asset_ids"]?.arrayValue, !idsArray.isEmpty else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`asset_ids` must be a non-empty array of photo IDs.")
    }
    if idsArray.count > 20 {
      throw AgentError(
        code: "invalid_arguments",
        message: "`asset_ids` cannot contain more than 20 photo IDs at once.")
    }
    let maxEdge = try integer(arguments, key: "max_edge", range: 256...1024, defaultValue: 512)

    var images: [AgentImage] = []
    var thumbnailsMeta: [JSONValue] = []

    for idVal in idsArray {
      guard let idStr = idVal.stringValue, let uuid = UUID(uuidString: idStr) else {
        throw AgentError(
          code: "invalid_arguments",
          message: "Invalid photo ID: `\(idVal)`.")
      }
      guard let asset = delegate.browseAssets.first(where: { $0.id == uuid }) else {
        throw AgentError(
          code: "asset_not_found",
          message: "No photo found with ID `\(idStr)` in the active collection.")
      }
      if let (jpegData, width, height) = await loadThumbnailJPEG(
        for: asset, delegate: delegate, activeSession: activeSession, maxEdge: maxEdge)
      {
        images.append(AgentImage(data: jpegData, mimeType: "image/jpeg"))
        thumbnailsMeta.append([
          "asset_id": .string(idStr),
          "name": .string(asset.displayName),
          "width": .int(width),
          "height": .int(height),
        ])
      } else {
        throw AgentError(
          code: "thumbnail_unavailable",
          message: "Could not generate or load thumbnail for `\(asset.displayName)`.")
      }
    }

    return AgentPayload(
      result: [
        "thumbnails": .array(thumbnailsMeta),
        "count": .int(thumbnailsMeta.count),
      ],
      images: images
    )
  }

  static func setRating(
    _ arguments: [String: JSONValue],
    delegate: (any AgentBrowseDelegate)?,
    activeSession: EditSession?
  ) async throws -> JSONValue {
    guard let delegate else {
      throw AgentError(
        code: "browse_unavailable",
        message: "Maple is not currently browsing a library or folder.")
    }
    guard let idStr = arguments["asset_id"]?.stringValue, let uuid = UUID(uuidString: idStr) else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`asset_id` must be a valid photo UUID.")
    }
    let rating = try integer(arguments, key: "rating", range: 0...5)

    guard let asset = delegate.browseAssets.first(where: { $0.id == uuid }) else {
      throw AgentError(
        code: "asset_not_found",
        message: "No photo found with ID `\(idStr)` in the active collection.")
    }

    let updatedCulling = try await delegate.updateCulling(assetID: uuid) { culling in
      culling.stars = rating
    }
    if activeSession?.asset.id == uuid {
      activeSession?.culling.stars = rating
    }

    var result: [String: JSONValue] = [
      "asset_id": .string(idStr),
      "name": .string(asset.displayName),
      "rating": .int(updatedCulling.stars),
      "flag": .string(updatedCulling.flag.rawValue),
    ]
    if let color = updatedCulling.colorLabel {
      result["color_label"] = .string(color.rawValue)
    }
    return .object(result)
  }

  static func setFlag(
    _ arguments: [String: JSONValue],
    delegate: (any AgentBrowseDelegate)?,
    activeSession: EditSession?
  ) async throws -> JSONValue {
    guard let delegate else {
      throw AgentError(
        code: "browse_unavailable",
        message: "Maple is not currently browsing a library or folder.")
    }
    guard let idStr = arguments["asset_id"]?.stringValue, let uuid = UUID(uuidString: idStr) else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`asset_id` must be a valid photo UUID.")
    }
    guard let flagStr = arguments["flag"]?.stringValue, let flag = CullFlag(rawValue: flagStr)
    else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`flag` must be 'none', 'pick', or 'reject'.")
    }
    guard let asset = delegate.browseAssets.first(where: { $0.id == uuid }) else {
      throw AgentError(
        code: "asset_not_found",
        message: "No photo found with ID `\(idStr)` in the active collection.")
    }

    let updatedCulling = try await delegate.updateCulling(assetID: uuid) { culling in
      culling.flag = flag
    }
    if activeSession?.asset.id == uuid {
      activeSession?.culling.flag = flag
    }

    var result: [String: JSONValue] = [
      "asset_id": .string(idStr),
      "name": .string(asset.displayName),
      "rating": .int(updatedCulling.stars),
      "flag": .string(updatedCulling.flag.rawValue),
    ]
    if let color = updatedCulling.colorLabel {
      result["color_label"] = .string(color.rawValue)
    }
    return .object(result)
  }

  static func openPhoto(
    _ arguments: [String: JSONValue],
    delegate: (any AgentBrowseDelegate)?
  ) async throws -> EditSession {
    guard let delegate else {
      throw AgentError(
        code: "browse_unavailable",
        message: "Maple is not currently browsing a library or folder.")
    }
    guard let idStr = arguments["asset_id"]?.stringValue, let uuid = UUID(uuidString: idStr) else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`asset_id` must be a valid photo UUID.")
    }
    guard delegate.browseAssets.contains(where: { $0.id == uuid }) else {
      throw AgentError(
        code: "asset_not_found",
        message: "No photo found with ID `\(idStr)` in the active collection.")
    }
    return try await delegate.openPhoto(assetID: uuid)
  }

  private static func integer(
    _ arguments: [String: JSONValue], key: String, range: ClosedRange<Int>,
    defaultValue: Int? = nil
  ) throws -> Int {
    if arguments[key] == nil, let defaultValue { return defaultValue }
    guard let value = arguments[key]?.numberValue, let integer = Int(exactly: value),
      range.contains(integer)
    else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`\(key)` must be an integer between \(range.lowerBound) and \(range.upperBound).")
    }
    return integer
  }

  static func cullingState(
    for asset: AssetRef, session: EditSession?, store: (any SidecarStoreProtocol)?
  ) async -> CullingState {
    // A realized Browse cell may exist while hydration is still pending. Only
    // loaded or explicitly edited state can outrank the persisted sidecar.
    if let session, session.hasLoadedSidecar || session.sidecarUpdateTask != nil {
      return session.culling
    }
    let startingCulling = session?.culling
    let persisted: CullingState?
    if asset.primaryURL == nil {
      // The configured actor owns remote/PhotoKit sidecar access. Reading it
      // does not hydrate the editor or open/decode the original image.
      persisted = try? await store?.loadIfPresent()?.1
    } else {
      let task = Task.detached(priority: .utility) { () -> CullingState? in
        guard !Task.isCancelled, let url = asset.primaryURL else { return nil }
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let claimed = scope.startAccessingSecurityScopedResource()
        defer { if claimed { scope.stopAccessingSecurityScopedResource() } }
        let sidecar = SidecarPath.sidecarURL(for: url)
        guard let xml = try? String(contentsOf: sidecar, encoding: .utf8),
          !Task.isCancelled, let (_, culling) = try? XMPParser.parse(xml)
        else { return nil }
        return culling
      }
      persisted = await withTaskCancellationHandler {
        await task.value
      } onCancel: {
        task.cancel()
      }
    }
    // Rehydrate/edit completion during the disk read owns the newer state.
    // This query never writes disk results into the edit session.
    if let session,
      session.hasLoadedSidecar || session.sidecarUpdateTask != nil
        || session.culling != startingCulling
    {
      return session.culling
    }
    return persisted ?? startingCulling ?? CullingState()
  }

  static func captureTimestamp(for asset: AssetRef) async -> String? {
    if let date = asset.captureDate {
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      return formatter.string(from: date)
    }
    guard let url = asset.primaryURL else { return nil }
    let scope = asset.scopeParentURL
    return await Task.detached(priority: .utility) {
      let claimed = scope?.startAccessingSecurityScopedResource() ?? false
      defer { if claimed { scope?.stopAccessingSecurityScopedResource() } }
      let dates = ImageMetadataReader.readRawCaptureDateStrings(from: url)
      return dates.dateTimeOriginal.flatMap(ExifCaptureDate.iso8601UTC(fromExifString:))
        ?? dates.createDate.flatMap(ExifCaptureDate.iso8601UTC(fromExifString:))
    }.value
  }

}
