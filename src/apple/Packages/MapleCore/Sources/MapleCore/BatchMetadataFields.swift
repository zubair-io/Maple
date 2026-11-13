// BatchMetadataFields.swift — the field model of the Batch Metadata sheet:
// which metadata fields exist, and which of them the user touched. Split
// from BatchMetadataViewModel.swift (file-size budget, #2311).

import Foundation

// MARK: - MetadataFieldKey

/// Every editable metadata field, used to track mixed-value detection.
public enum MetadataFieldKey: String, CaseIterable {
  case gpsLatitude, gpsLongitude, gpsAltitude
  case dateTimeOriginal, timeZone
  case sublocation, city, state, country, countryCode
  case title, caption, headline, keywords, instructions
  case creator, creatorJobTitle, copyrightNotice, copyrightStatus
  case usageTerms, credit, source
  case rating  // Maps to CullingState.stars
  case flag  // Maps to CullingState.flag
  case hidden  // Maps to CullingState.hidden
  case colorLabel  // Maps to CullingState.colorLabel
}

// MARK: - TouchedMetadata

/// The subset of `XmpMetadata` fields the user explicitly changed.
/// `nil` means "not touched" (leave the per-asset existing value alone).
/// An empty `String?` value (i.e. `Optional("")`) means "explicitly cleared".
///
/// GPS lat/lon/alt are `Double??`: outer nil = untouched; `.some(nil)` = clear.
/// `keywords` is `[String]??`: outer nil = untouched; `.some([])` = explicit clear.
public struct TouchedMetadata {
  public var gpsLatitude: Double?? = nil
  public var gpsLongitude: Double?? = nil
  public var gpsAltitude: Double?? = nil
  public var dateTimeOriginal: String? = nil
  public var timeZone: String? = nil
  public var sublocation: String? = nil
  public var city: String? = nil
  public var state: String? = nil
  public var country: String? = nil
  public var countryCode: String? = nil
  public var title: String? = nil
  public var caption: String? = nil
  public var headline: String? = nil
  public var keywords: [String]?? = nil
  public var instructions: String? = nil
  public var creator: String? = nil
  public var creatorJobTitle: String? = nil
  public var copyrightNotice: String? = nil
  public var copyrightStatus: CopyrightStatus?? = nil
  public var usageTerms: String? = nil
  public var credit: String? = nil
  public var source: String? = nil
  /// Star rating to apply. nil = untouched; 0 = explicitly clear (no stars).
  public var stars: Int? = nil
  /// Pick/reject flag. nil = untouched.
  public var flag: CullFlag? = nil
  /// Hidden flag. nil = untouched.
  public var hidden: Bool? = nil
  /// Color label (#1656). Double-optional like `copyrightStatus`, and for
  /// the same reason: the underlying field is itself optional, so "clear
  /// the label on every selected photo" has no in-band sentinel the way
  /// `stars = 0` / `flag = .none` do. Outer nil = untouched; `.some(nil)`
  /// = explicit clear; `.some(.blue)` = set to blue.
  public var colorLabel: ColorLabel?? = nil

  public init() {}

  /// True iff at least one field has been touched.
  public var hasTouched: Bool {
    gpsLatitude != nil || gpsLongitude != nil || gpsAltitude != nil || dateTimeOriginal != nil
      || timeZone != nil || sublocation != nil || city != nil || state != nil || country != nil
      || countryCode != nil || title != nil || caption != nil || headline != nil || keywords != nil
      || instructions != nil || creator != nil || creatorJobTitle != nil || copyrightNotice != nil
      || copyrightStatus != nil || usageTerms != nil || credit != nil || source != nil
      || stars != nil || flag != nil || hidden != nil || colorLabel != nil
  }
}
