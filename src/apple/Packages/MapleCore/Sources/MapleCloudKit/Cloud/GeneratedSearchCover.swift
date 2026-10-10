// GeneratedSearchCover.swift
//
// What a For You card needs to draw its cover: the thumbnail route is addressed
// by path, so the stored `cover_asset_id` has to be resolved to one.

import Foundation

public struct GeneratedSearchCover: Equatable, Sendable, Identifiable {
  public let id: String
  public let absPath: String
  public let filename: String

  public init(id: String, absPath: String, filename: String) {
    self.id = id
    self.absPath = absPath
    self.filename = filename
  }

  init(asset: SearchAsset) {
    self.init(id: asset.id, absPath: asset.abs_path, filename: asset.filename)
  }
}

struct GeneratedSearchCoverResponse: Decodable, Sendable {
  let absPath: String
  let filename: String

  private enum CodingKeys: String, CodingKey {
    case absPath = "abs_path"
    case filename
  }
}
