// CloudAssetDetailModels.swift — wire + display models for the Info pane's
// rich server detail (#2518). Split from CloudAssetDetailClient.swift to keep
// the client file lean.
//
// Two layers:
//   • Wire models (`CloudPlace`, `CloudVision`, `CloudFace`, …) decode the
//     subset of `AssetDetailDto` the pane renders. Field names/CodingKeys
//     mirror `src/api/src/db/schema.ts` exactly.
//   • Display models (`CloudPlaceDisplay`, `CloudVisionDisplay`,
//     `CloudFacesDisplay`) are pre-formatted, trimmed, `Sendable` projections
//     the SwiftUI section views render verbatim — unit-tested without a live
//     server.

import Foundation

// MARK: - Wire models (decode subset of AssetDetailDto)

/// `Place.address` (schema.ts `PlaceAddress`) — only the tiers the pane needs.
public struct CloudPlaceAddress: Decodable, Equatable, Sendable {
  public let city: String?
  public let town: String?
  public let village: String?
  public let county: String?
  public let state: String?
  public let country: String?
}

/// `Place.rollups` (schema.ts `PlaceRollups`).
public struct CloudPlaceRollups: Decodable, Equatable, Sendable {
  public let locality: String?
  public let region: String?
  public let countryCode: String?

  private enum CodingKeys: String, CodingKey {
    case locality, region
    case countryCode = "country_code"
  }
}

/// `Place` (schema.ts) — display_name + structured address + rollups.
public struct CloudPlace: Decodable, Equatable, Sendable {
  public let displayName: String?
  public let address: CloudPlaceAddress?
  public let rollups: CloudPlaceRollups?

  private enum CodingKeys: String, CodingKey {
    case displayName = "display_name"
    case address, rollups
  }
}

/// `VisionDoc` (schema.ts) — the categorical/free-text tags the Vision
/// section chips. String-typed (not the server enums) since the pane only
/// displays the raw value. Arrays default to empty and `is_screenshot` to
/// false so a partial subdoc still decodes.
public struct CloudVision: Decodable, Equatable, Sendable {
  public let subjects: [String]
  public let sceneType: String?
  public let setting: String?
  public let activity: String?
  public let timeOfDay: String?
  public let lighting: String?
  public let weather: String?
  public let mood: String?
  public let composition: String?
  public let colors: [String]
  public let notableObjects: [String]
  public let shotType: String?
  public let isScreenshot: Bool

  private enum CodingKeys: String, CodingKey {
    case subjects
    case sceneType = "scene_type"
    case setting, activity
    case timeOfDay = "time_of_day"
    case lighting, weather, mood, composition, colors
    case notableObjects = "notable_objects"
    case shotType = "shot_type"
    case isScreenshot = "is_screenshot"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    subjects = try c.decodeIfPresent([String].self, forKey: .subjects) ?? []
    sceneType = try c.decodeIfPresent(String.self, forKey: .sceneType)
    setting = try c.decodeIfPresent(String.self, forKey: .setting)
    activity = try c.decodeIfPresent(String.self, forKey: .activity)
    timeOfDay = try c.decodeIfPresent(String.self, forKey: .timeOfDay)
    lighting = try c.decodeIfPresent(String.self, forKey: .lighting)
    weather = try c.decodeIfPresent(String.self, forKey: .weather)
    mood = try c.decodeIfPresent(String.self, forKey: .mood)
    composition = try c.decodeIfPresent(String.self, forKey: .composition)
    colors = try c.decodeIfPresent([String].self, forKey: .colors) ?? []
    notableObjects = try c.decodeIfPresent([String].self, forKey: .notableObjects) ?? []
    shotType = try c.decodeIfPresent(String.self, forKey: .shotType)
    isScreenshot = try c.decodeIfPresent(Bool.self, forKey: .isScreenshot) ?? false
  }
}

/// `VisionMeta` (schema.ts) — provenance footer for the Vision section.
public struct CloudVisionMeta: Decodable, Equatable, Sendable {
  public let model: String?
  public let promptVersion: Int?

  private enum CodingKeys: String, CodingKey {
    case model
    case promptVersion = "prompt_version"
  }
}

/// `AssetFaceDoc` (schema.ts) — only the identity fields the pane needs.
public struct CloudFace: Decodable, Equatable, Sendable {
  public let personID: String?
  public let confidence: Double?

  private enum CodingKeys: String, CodingKey {
    case personID = "person_id"
    case confidence
  }
}

// MARK: - Display models (pre-formatted, view-ready)

/// Place section, ready to render. `rollupLine` mirrors the web
/// `formatRollups` (locality, region joined by ", "; nil when both blank).
public struct CloudPlaceDisplay: Equatable, Sendable {
  public let rollupLine: String?
  public let displayName: String?

  public init(rollupLine: String?, displayName: String?) {
    self.rollupLine = rollupLine
    self.displayName = displayName
  }
}

/// Vision section, ready to render. Chip groups mirror the web `info-vision`
/// row order: primary (scene/setting/activity/shot-type), secondary
/// (mood/composition/time/lighting/weather), then subjects / objects / colors.
public struct CloudVisionDisplay: Equatable, Sendable {
  public let isScreenshot: Bool
  public let subjects: [String]
  public let primaryChips: [String]
  public let secondaryChips: [String]
  public let notableObjects: [String]
  public let colors: [String]
  public let footer: String?

  public init(
    isScreenshot: Bool,
    subjects: [String],
    primaryChips: [String],
    secondaryChips: [String],
    notableObjects: [String],
    colors: [String],
    footer: String?
  ) {
    self.isScreenshot = isScreenshot
    self.subjects = subjects
    self.primaryChips = primaryChips
    self.secondaryChips = secondaryChips
    self.notableObjects = notableObjects
    self.colors = colors
    self.footer = footer
  }

  /// True when there is nothing at all to show — the section then hides.
  public var isEmpty: Bool {
    !isScreenshot && subjects.isEmpty && primaryChips.isEmpty
      && secondaryChips.isEmpty && notableObjects.isEmpty && colors.isEmpty
  }
}

/// Faces section, ready to render — mirrors web `info-faces`.
public struct CloudFacesDisplay: Equatable, Sendable {
  public let count: Int
  public let taggedPersonIDs: [String]
  public let untaggedCount: Int

  public init(count: Int, taggedPersonIDs: [String], untaggedCount: Int) {
    self.count = count
    self.taggedPersonIDs = taggedPersonIDs
    self.untaggedCount = untaggedCount
  }
}
