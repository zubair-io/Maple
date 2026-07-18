// CloudAsset.swift
//
// DTOs for the cloud filesystem-walk endpoints. Mirrors the server's
// FsDirListing shape from `src/api/src/fs/browse.ts` so listing a
// folder gives subfolders + image files at one level (NOT recursive).
//
// Why not /api/folders/:id/assets? That endpoint returns the indexed
// Mongo flat list — useful for indexer state but not for user-facing
// browsing because (a) it doesn't expose subfolder structure, and (b)
// indexed assets lag the filesystem when the library has just been
// added or files have been moved. The web app made the same switch
// in its "Phase B browse" — registered libraries from /api/folders
// are sidebar roots; the contents come from /api/fs/dir.

import Foundation

/// One subdirectory entry from `/api/fs/dir`.
public struct FsDirEntry: Decodable, Equatable, Sendable {
  public let name: String
  public let path: String
  public let mtime: String
}

/// EXIF subset returned by `/api/fs/dir` per image. Optional throughout —
/// `nil` means the indexer hasn't run yet for this file.
public struct FsImageExif: Decodable, Equatable, Sendable {
  public let captured_at: String?
  public let camera_make: String?
  public let camera_model: String?
  public let lens: String?
  public let iso: Int?
  public let aperture: Double?
  public let shutter: String?
  public let focal_length: Double?
}

/// One image entry from `/api/fs/dir`.
public struct FsImageEntry: Decodable, Equatable, Sendable {
  public let name: String
  public let path: String
  public let mtime: String
  public let size: Int64
  public let ext: String
  public let exif: FsImageExif?
}

/// Full response shape of `/api/fs/dir?path=<abs>`.
public struct FsDirListing: Decodable, Sendable {
  public let path: String
  public let parent: String?
  public let dirs: [FsDirEntry]
  public let images: [FsImageEntry]
}
