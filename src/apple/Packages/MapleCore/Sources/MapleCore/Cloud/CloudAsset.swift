// CloudAsset.swift
//
// DTOs for `GET /api/folders/:id/assets`.

import Foundation

public struct CloudAsset: Decodable, Equatable, Sendable {
  public let id: String
  public let filename: String
  public let size: Int64
  public let mtime: String
  public let rating: Int?
  public let flag: String?
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
