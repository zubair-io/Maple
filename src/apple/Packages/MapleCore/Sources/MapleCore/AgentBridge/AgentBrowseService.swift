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
    let offset: Int
    if let offsetVal = arguments["offset"]?.numberValue {
      guard offsetVal.rounded() == offsetVal, offsetVal >= 0 else {
        throw AgentError(
          code: "invalid_arguments",
          message: "`offset` must be a non-negative integer.")
      }
      offset = Int(offsetVal)
    } else {
      offset = 0
    }
    let limit: Int
    if let limitVal = arguments["limit"]?.numberValue {
      guard limitVal.rounded() == limitVal, (1...100).contains(Int(limitVal)) else {
        throw AgentError(
          code: "invalid_arguments",
          message: "`limit` must be an integer between 1 and 100.")
      }
      limit = Int(limitVal)
    } else {
      limit = 50
    }

    let allAssets = delegate.browseAssets
    let totalCount = allAssets.count
    let slice: ArraySlice<AssetRef>
    if offset < totalCount {
      slice = allAssets[offset..<min(offset + limit, totalCount)]
    } else {
      slice = []
    }

    // Snapshot in-memory session culling states on @MainActor so we don't
    // access MainActor properties inside the detached background task.
    var sessionCulling: [AssetRef.ID: CullingState] = [:]
    for asset in slice {
      if activeSession?.asset.id == asset.id, let c = activeSession?.culling {
        sessionCulling[asset.id] = c
      } else if let s = delegate.session(for: asset) {
        sessionCulling[asset.id] = s.culling
      }
    }
    let sliceAssets = Array(slice)
    let activeID = activeSession?.asset.id

    // Perform sidecar disk parsing and EXIF header reading off @MainActor
    // to prevent blocking the UI thread during large folder listings.
    let photos: [JSONValue] = await Task.detached(priority: .userInitiated) {
      sliceAssets.map { asset in
        var photoObj: [String: JSONValue] = [
          "id": .string(asset.id.uuidString),
          "name": .string(asset.displayName),
          "is_active": .bool(activeID == asset.id),
        ]
        if let path = asset.primaryURL?.path {
          photoObj["path"] = .string(path)
        }
        let culling = cullingState(for: asset, cached: sessionCulling[asset.id])
        photoObj["rating"] = .int(culling.stars)
        photoObj["flag"] = .string(culling.flag.rawValue)
        if let color = culling.colorLabel {
          photoObj["color_label"] = .string(color.rawValue)
        }
        if let captureTime = captureTimestamp(for: asset) {
          photoObj["capture_time"] = .string(captureTime)
        }
        return .object(photoObj)
      }
    }.value

    var result: [String: JSONValue] = [
      "photos": .array(photos),
      "total_count": .int(totalCount),
      "offset": .int(offset),
      "limit": .int(limit),
      "collection_name": .string(delegate.activeCollectionName ?? "Library"),
    ]
    if let folderPath = delegate.activeFolderPath {
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
    let maxEdge: Int
    if let maxEdgeVal = arguments["max_edge"]?.numberValue {
      guard maxEdgeVal.rounded() == maxEdgeVal, (256...1024).contains(Int(maxEdgeVal)) else {
        throw AgentError(
          code: "invalid_arguments",
          message: "`max_edge` must be an integer between 256 and 1024.")
      }
      maxEdge = Int(maxEdgeVal)
    } else {
      maxEdge = 512
    }

    var images: [AgentImage] = []
    var thumbnailsMeta: [JSONValue] = []
    var errors: [String] = []

    for idVal in idsArray {
      guard let idStr = idVal.stringValue, let uuid = UUID(uuidString: idStr) else {
        thumbnailsMeta.append([
          "asset_id": idVal,
          "error": .string("Invalid photo UUID: `\(idVal)`"),
          "status": .string("error"),
        ])
        errors.append("Invalid photo UUID: `\(idVal)`")
        continue
      }
      guard let asset = delegate.browseAssets.first(where: { $0.id == uuid }) else {
        thumbnailsMeta.append([
          "asset_id": .string(idStr),
          "error": .string("No photo found with ID `\(idStr)` in the active collection."),
          "status": .string("error"),
        ])
        errors.append("No photo found with ID `\(idStr)` in the active collection.")
        continue
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
          "status": .string("ok"),
        ])
      } else {
        thumbnailsMeta.append([
          "asset_id": .string(idStr),
          "name": .string(asset.displayName),
          "error": .string("Could not generate or load thumbnail for `\(asset.displayName)`."),
          "status": .string("error"),
        ])
        errors.append("Could not generate or load thumbnail for `\(asset.displayName)`.")
      }
    }

    if images.isEmpty && !errors.isEmpty {
      throw AgentError(
        code: "thumbnail_unavailable",
        message: "Failed to load any thumbnails: " + errors.joined(separator: "; "))
    }

    return AgentPayload(
      result: [
        "thumbnails": .array(thumbnailsMeta),
        "count": .int(images.count),
      ],
      images: images)
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
    guard let ratingNum = arguments["rating"]?.numberValue,
      ratingNum.rounded() == ratingNum,
      (0...5).contains(Int(ratingNum))
    else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`rating` must be an integer between 0 and 5.")
    }
    let rating = Int(ratingNum)
    guard let asset = delegate.browseAssets.first(where: { $0.id == uuid }) else {
      throw AgentError(
        code: "asset_not_found",
        message: "No photo found with ID `\(idStr)` in the active collection.")
    }

    // Early-out if rating is already set to this value to avoid unnecessary disk writes and mtime bumps.
    let current = cullingState(
      for: asset,
      cached: activeSession?.asset.id == uuid
        ? activeSession?.culling : delegate.session(for: asset)?.culling)
    if current.stars == rating {
      var result: [String: JSONValue] = [
        "asset_id": .string(idStr),
        "name": .string(asset.displayName),
        "rating": .int(current.stars),
        "flag": .string(current.flag.rawValue),
      ]
      if let color = current.colorLabel {
        result["color_label"] = .string(color.rawValue)
      }
      return .object(result)
    }

    let updatedCulling = try await delegate.updateCulling(assetID: uuid) { culling in
      culling.stars = rating
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

    // Early-out if flag is already set to this value to avoid unnecessary disk writes and mtime bumps.
    let current = cullingState(
      for: asset,
      cached: activeSession?.asset.id == uuid
        ? activeSession?.culling : delegate.session(for: asset)?.culling)
    if current.flag == flag {
      var result: [String: JSONValue] = [
        "asset_id": .string(idStr),
        "name": .string(asset.displayName),
        "rating": .int(current.stars),
        "flag": .string(current.flag.rawValue),
      ]
      if let color = current.colorLabel {
        result["color_label"] = .string(color.rawValue)
      }
      return .object(result)
    }

    let updatedCulling = try await delegate.updateCulling(assetID: uuid) { culling in
      culling.flag = flag
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
}
