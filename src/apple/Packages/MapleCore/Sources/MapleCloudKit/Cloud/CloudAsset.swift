// Native Browse DTOs for the enriched `/api/folder/:slug/*` response.
// `parent` is explicitly decoded from absolute `parentPath`; the wire's
// `parent` is a unified address and must never enter filesystem navigation.

import Foundation

/// One subdirectory entry from `/api/folder/:slug/*`.
public struct FsDirEntry: Decodable, Equatable, Sendable {
  public let name: String
  public let path: String
  public let mtime: String
  /// Physical directory identity for cycle-safe destination trees (#4017).
  public let realPath: String?
}

/// EXIF subset returned by `/api/folder/:slug/*` per image. Optional throughout —
/// `nil` means the indexer hasn't run yet for this file.
public struct FsImageExif: Decodable, Equatable, Sendable {
  public let capturedAt: String?
  public let cameraMake: String?
  public let cameraModel: String?
  public let lens: String?
  public let iso: Int?
  public let aperture: Double?
  public let shutter: String?
  public let focalLength: Double?

  private enum CodingKeys: String, CodingKey {
    case lens, iso, aperture, shutter
    case capturedAt = "captured_at"
    case cameraMake = "camera_make"
    case cameraModel = "camera_model"
    case focalLength = "focal_length"
  }
}

/// One half of an Apple Live Photo pair, as the folder listing reports it
/// (docs/api.md "Live Photo pairs"): this entry's role and the filename of
/// the other half in the same folder.
public struct LivePhotoLink: Decodable, Hashable, Sendable {
  public enum Role: String, Decodable, Hashable, Sendable {
    case still
    case clip
  }

  public let role: Role
  public let partner: String

  public init(role: Role, partner: String) {
    self.role = role
    self.partner = partner
  }

  /// The partner's `fs:<absolute path>` id: this entry's folder plus the partner filename.
  public func partnerRefID(ofRefID refID: String) -> String {
    guard let separator = refID.lastIndex(of: "/") else { return partner }
    return "\(refID[...separator])\(partner)"
  }
}

/// The JPEG folded into a RAW's entry when the listing stacks a RAW+JPEG pair (docs/api.md
/// "RAW+JPEG stacks", #5050): the JPEG's own listing entry, with its asset `id` once indexed.
public struct FsStackCompanion: Decodable, Equatable, Hashable, Sendable {
  public let name: String
  public let address: String
  public let path: String
  public let size: Int64
  public let mtime: String
  public let ext: String
  public let id: String?
}

public struct FsStack: Decodable, Equatable, Sendable {
  public let companion: FsStackCompanion
}

/// One image entry from `/api/folder/:slug/*`.
public struct FsImageEntry: Decodable, Equatable, Sendable {
  public let name: String
  public let path: String
  public let mtime: String
  public let size: Int64
  public let ext: String
  public let exif: FsImageExif?
  public let livePhoto: LivePhotoLink?
  public let stack: FsStack?
}

/// Full response shape of `/api/folder/:slug/*`.
public struct FsDirListing: Decodable, Sendable {
  public let path: String
  public let realPath: String?
  public let parent: String?
  public let dirs: [FsDirEntry]
  public let images: [FsImageEntry]

  private enum CodingKeys: String, CodingKey {
    case path, images, realPath
    case parent = "parentPath"
    case dirs = "folders"
  }
}
