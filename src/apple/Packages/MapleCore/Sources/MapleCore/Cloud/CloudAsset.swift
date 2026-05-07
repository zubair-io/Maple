// CloudAsset.swift
//
// DTOs for `GET /api/folders/:id/assets`.

import Foundation

public struct CloudAsset: Decodable, Equatable, Sendable {
  public let id: String
  public let filename: String
  public let size: Int64
  /// Last-modified epoch ms from `stat`. Wire format is a JSON number,
  /// not a string — see `AssetDoc.mtime` in `src/api/src/db/schema.ts`.
  public let mtime: Int64
  public let rating: Int?
  /// Pick flag: 1 = pick, 0 = none, -1 = reject. Wire format is a number.
  public let flag: Int?
  public let color_label: String?
  public let indexed_at: String?
}

public struct CloudAssetsPage: Decodable, Sendable {
  public let folder_id: String
  public let page: Int
  public let limit: Int
  public let total: Int
  public let assets: [CloudAsset]
}
