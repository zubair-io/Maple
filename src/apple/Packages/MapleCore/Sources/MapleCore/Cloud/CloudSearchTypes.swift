// CloudSearchTypes.swift
//
// DTOs for /api/search/buckets and /api/search. Mirrors the server's wire
// format from src/api/src/routes/search.ts. Keep field names exactly as
// the server emits them — these are decoded from raw JSON.

import Foundation

public struct TimelineBucket: Codable, Equatable, Sendable {
  public let year: Int
  public let month: Int
  public let count: Int

  public init(year: Int, month: Int, count: Int) {
    self.year = year; self.month = month; self.count = count
  }
}

public struct TimelineBuckets: Codable, Sendable {
  public let total: Int
  public let buckets: [TimelineBucket]
  public let untimed_count: Int

  public init(total: Int, buckets: [TimelineBucket], untimed_count: Int) {
    self.total = total; self.buckets = buckets; self.untimed_count = untimed_count
  }
}

public struct SearchAssetCamera: Codable, Equatable, Sendable {
  public let make: String?
  public let model: String?
}

public struct SearchAsset: Codable, Equatable, Sendable {
  public let id: String
  public let folder_id: String
  public let abs_path: String
  public let filename: String
  public let size: Int64?
  /// Last-modified epoch ms. Wire format is a JSON number — usually an
  /// integer, but the server sometimes sends a fractional value (e.g.
  /// `1776035930475.9543` for a few panorama assets where MongoDB
  /// returned a Decimal128 / Double instead of a NumberLong). Decoding
  /// as Double tolerates both shapes; integer milliseconds round-trip
  /// without loss. Truncate to Int64 if the caller needs that.
  public let mtime: Double?
  public let captured_at: String?
  public let camera: SearchAssetCamera?
  public let lens: String?
  public let iso: Int?
  public let aperture: Double?
  public let shutter: String?
  public let focal_length: Double?
  public let rating: Int?
  /// Pick flag: 1 = pick, 0 = none, -1 = reject. Number on the wire.
  public let flag: Int?
  public let color_label: String?
}

public struct SearchResponse: Codable, Sendable {
  public let total: Int
  public let page: Int
  public let limit: Int
  public let results: [SearchAsset]
}
