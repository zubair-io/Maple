// CloudAssetDetailClient.swift
//
// Wraps `GET /api/assets/:id` for the S6 Info panel's enrichment block:
// the AI-derived, per-asset data the Self-Hosted worker stages produce
// (description, OCR text, transcript). This data lives in Mongo only —
// never in the XMP sidecar — so it is fetched from the server rather than
// read off the local file.
//
// Only Self-Hosted (cloud-shaped) assets carry a server `ObjectId`, so
// this client is injected the same way `CloudHistogramClient` is: present
// only after a cloud asset is opened, `nil` for filesystem / PhotoKit
// assets (the enrichment block hides itself in that case).
//
// The wire response is the full `AssetDetailDto`; we decode only the
// subset the Info panel renders. `JSONDecoder` ignores the other keys.

import Foundation

/// Decoded subset of `GET /api/assets/:id` (and `/by-address`) — the fields
/// the Info panel surfaces. Other DTO keys are skipped by the decoder.
public struct CloudAssetDetail: Decodable, Equatable, Sendable {
  /// qwen3-vl caption from the describe stage. `null`/absent until it runs.
  public let description: String?
  /// Recognised text, mirrored from `vision.text_visible`. Empty string
  /// when the model saw no text; `null`/absent before the stage runs.
  public let ocrText: String?
  /// Speech-to-text from the transcribe stage (video/audio only).
  public let transcript: CloudTranscript?
  /// Server-side absolute path (`abs_path`). Also carried on
  /// `AssetRef.catalog`; kept here so a local-less consumer can read it.
  public let absPath: String?
  /// File size in bytes.
  public let size: Int64?
  /// Reverse-geocoded place (structured address + rollups). `null` until
  /// geocoded / no GPS.
  public let place: CloudPlace?
  /// Structured vision tags. `null` until the describe stage runs.
  public let vision: CloudVision?
  /// Vision provenance (model / prompt version) for the section footer.
  public let visionMeta: CloudVisionMeta?
  /// Detected faces. Empty until the face stage runs.
  public let faces: [CloudFace]
  /// `slug:relPath` address — present on the `by-fspath` response (cloud
  /// browse) so the pane can show the library-relative folder; absent on the
  /// plain `/:id` / `by-address` responses.
  public let address: String?

  private enum CodingKeys: String, CodingKey {
    case description
    case ocrText = "ocr_text"
    case transcript
    case absPath = "abs_path"
    case size, place, vision
    case visionMeta = "vision_meta"
    case faces
    case address
  }

  public init(
    description: String?,
    ocrText: String?,
    transcript: CloudTranscript?,
    absPath: String? = nil,
    size: Int64? = nil,
    place: CloudPlace? = nil,
    vision: CloudVision? = nil,
    visionMeta: CloudVisionMeta? = nil,
    faces: [CloudFace] = [],
    address: String? = nil
  ) {
    self.description = description
    self.ocrText = ocrText
    self.transcript = transcript
    self.absPath = absPath
    self.size = size
    self.place = place
    self.vision = vision
    self.visionMeta = visionMeta
    self.faces = faces
    self.address = address
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    description = try c.decodeIfPresent(String.self, forKey: .description)
    ocrText = try c.decodeIfPresent(String.self, forKey: .ocrText)
    transcript = try c.decodeIfPresent(CloudTranscript.self, forKey: .transcript)
    absPath = try c.decodeIfPresent(String.self, forKey: .absPath)
    size = try c.decodeIfPresent(Int64.self, forKey: .size)
    place = try c.decodeIfPresent(CloudPlace.self, forKey: .place)
    vision = try c.decodeIfPresent(CloudVision.self, forKey: .vision)
    visionMeta = try c.decodeIfPresent(CloudVisionMeta.self, forKey: .visionMeta)
    faces = try c.decodeIfPresent([CloudFace].self, forKey: .faces) ?? []
    address = try c.decodeIfPresent(String.self, forKey: .address)
  }

  /// Presentation projection: trims/formats every field so the section views
  /// render verbatim with no logic. Pure + `Sendable`, so it is unit-tested.
  public var sections: CloudEnrichmentSections {
    CloudEnrichmentSections(
      description: Self.nonEmpty(description),
      ocrText: Self.nonEmpty(ocrText),
      transcriptText: Self.nonEmpty(transcript?.text),
      transcriptFooter: transcript.flatMap { Self.footer(parts: [$0.language, $0.model]) },
      city: Self.city(from: place),
      fileSize: size,
      folderDisplay: address.map(Self.folder(fromAddress:)),
      place: Self.placeDisplay(place),
      vision: Self.visionDisplay(vision, meta: visionMeta),
      faces: Self.facesDisplay(faces)
    )
  }

  private static func nonEmpty(_ s: String?) -> String? {
    guard let trimmed = s?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
    else { return nil }
    return trimmed
  }

  /// `"en · whisper-base"`, dropping blank parts; `nil` when all blank.
  private static func footer(parts: [String?]) -> String? {
    let kept = parts
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return kept.isEmpty ? nil : kept.joined(separator: " · ")
  }

  /// Best city name: structured address tiers first, then the rollup
  /// locality. Mirrors what the web camera grid shows as "City".
  private static func city(from place: CloudPlace?) -> String? {
    guard let place else { return nil }
    return nonEmpty(place.address?.city)
      ?? nonEmpty(place.address?.town)
      ?? nonEmpty(place.address?.village)
      ?? nonEmpty(place.rollups?.locality)
  }

  /// `slug:relPath/filename` → `slug/relPathFolder` (drop the filename,
  /// render the colon as a slash) — the library-relative containing folder.
  /// Mirrors `AssetRef.displayFolder`; used for cloud browse assets, whose
  /// `address` arrives via the `by-fspath` fetch rather than up front.
  private static func folder(fromAddress address: String) -> String {
    if let slash = address.lastIndex(of: "/") {
      return address[..<slash].replacingOccurrences(of: ":", with: "/")
    }
    if let colon = address.firstIndex(of: ":") {
      return String(address[..<colon])
    }
    return address
  }

  private static func placeDisplay(_ place: CloudPlace?) -> CloudPlaceDisplay? {
    guard let place else { return nil }
    // Web `formatRollups`: [locality, region] joined by ", " (nil when both blank).
    let kept = [place.rollups?.locality, place.rollups?.region]
      .compactMap(nonEmpty)
    let rollup = kept.isEmpty ? nil : kept.joined(separator: ", ")
    return CloudPlaceDisplay(rollupLine: rollup, displayName: nonEmpty(place.displayName))
  }

  private static func visionDisplay(_ vision: CloudVision?, meta: CloudVisionMeta?)
    -> CloudVisionDisplay?
  {
    guard let vision else { return nil }
    let primary = [vision.sceneType, vision.setting, vision.activity, vision.shotType]
      .compactMap(nonEmpty)
    // Web drops weather values of "indoor" / "unknown".
    let weather = (vision.weather == "indoor" || vision.weather == "unknown") ? nil : vision.weather
    let secondary = [vision.mood, vision.composition, vision.timeOfDay, vision.lighting, weather]
      .compactMap(nonEmpty)
    let footerLine = meta.flatMap {
      guard let model = nonEmpty($0.model) else { return nil as String? }
      guard let v = $0.promptVersion else { return model }
      return "\(model) · prompt v\(v)"
    }
    let display = CloudVisionDisplay(
      isScreenshot: vision.isScreenshot,
      subjects: vision.subjects.compactMap(nonEmpty),
      primaryChips: primary,
      secondaryChips: secondary,
      notableObjects: vision.notableObjects.compactMap(nonEmpty),
      colors: vision.colors.compactMap(nonEmpty),
      footer: footerLine
    )
    return display.isEmpty ? nil : display
  }

  private static func facesDisplay(_ faces: [CloudFace]) -> CloudFacesDisplay {
    // A face is "tagged" when it has a person_id (named or not); the chip then
    // shows the resolved name (falling back to the id).
    let tagged = faces.compactMap { face -> FaceTag? in
      guard let pid = nonEmpty(face.personID) else { return nil }
      return FaceTag(personID: pid, name: nonEmpty(face.name))
    }
    return CloudFacesDisplay(
      count: faces.count,
      tagged: tagged,
      untaggedCount: faces.count - tagged.count
    )
  }
}

/// Display projection of `TranscriptDoc` returned by the API — the lean
/// shape (no per-segment timing array; the Info panel renders `text` as
/// one block).
public struct CloudTranscript: Decodable, Equatable, Sendable {
  public let text: String
  public let language: String
  public let model: String

  public init(text: String, language: String, model: String) {
    self.text = text
    self.language = language
    self.model = model
  }
}

/// The Info panel's enrichment sections, already trimmed for display.
/// A `nil` field means "no section to render." `isEmpty` lets the block
/// hide its header entirely when the asset carries no enrichment at all.
public struct CloudEnrichmentSections: Equatable, Sendable {
  public let description: String?
  public let ocrText: String?
  public let transcriptText: String?
  public let transcriptFooter: String?
  /// Best reverse-geocoded city name for the camera grid's "City" row.
  public let city: String?
  /// File size in bytes for the camera grid's "Size" row.
  public let fileSize: Int64?
  /// Library-relative containing folder for the camera grid's "Folder" row.
  /// Populated from the fetched `address` (cloud browse assets that had no
  /// address up front); `nil` when the asset already carried one.
  public let folderDisplay: String?
  /// Place section (rollup line + display name); `nil` when un-geocoded.
  public let place: CloudPlaceDisplay?
  /// Vision section; `nil` when the asset has no vision tags.
  public let vision: CloudVisionDisplay?
  /// Faces section — always present once the detail is fetched (count 0 ok).
  public let faces: CloudFacesDisplay

  public init(
    description: String?,
    ocrText: String?,
    transcriptText: String?,
    transcriptFooter: String?,
    city: String? = nil,
    fileSize: Int64? = nil,
    folderDisplay: String? = nil,
    place: CloudPlaceDisplay? = nil,
    vision: CloudVisionDisplay? = nil,
    faces: CloudFacesDisplay = CloudFacesDisplay(count: 0, tagged: [], untaggedCount: 0)
  ) {
    self.description = description
    self.ocrText = ocrText
    self.transcriptText = transcriptText
    self.transcriptFooter = transcriptFooter
    self.city = city
    self.fileSize = fileSize
    self.folderDisplay = folderDisplay
    self.place = place
    self.vision = vision
    self.faces = faces
  }

  /// True when the asset carries no enrichment content of any kind — no
  /// description/OCR/transcript, no place, no vision, and no faces.
  public var isEmpty: Bool {
    description == nil && ocrText == nil && transcriptText == nil
      && place == nil && vision == nil && faces.count == 0
  }
}

public actor CloudAssetDetailClient {
  public nonisolated let server: URL
  private let httpClient: AuthenticatedHTTPClient

  public init(server: URL, httpClient: AuthenticatedHTTPClient) {
    self.server = server
    self.httpClient = httpClient
  }

  /// Fetch the enrichment detail for `assetID` (Mongo ObjectId hex).
  /// Throws on any non-2xx response — the Info panel hides the block.
  public func detail(assetID: String) async throws -> CloudAssetDetail {
    let url = server
      .appending(path: "/api/assets/")
      .appending(path: assetID)
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw NSError(
        domain: "CloudAssetDetailClient",
        code: http.statusCode,
        userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? ""])
    }
    return try JSONDecoder().decode(CloudAssetDetail.self, from: data)
  }

  /// Fetch the detail for a `slug:relPath` unified address via
  /// `GET /api/assets/by-address?address=…`. This is the path the Info pane
  /// uses for cloud assets: the search/browse projection carries a stable
  /// `address` but the editor `id` (`fs:<absPath>`) is NOT a Mongo ObjectId,
  /// so the `/:id` route rejects it. Throws on any non-2xx — the pane hides.
  public func detail(address: String) async throws -> CloudAssetDetail {
    var components = URLComponents(
      url: server.appending(path: "/api/assets/by-address"),
      resolvingAgainstBaseURL: false)
    components?.queryItems = [URLQueryItem(name: "address", value: address)]
    guard let url = components?.url else {
      throw NSError(
        domain: "CloudAssetDetailClient", code: -1,
        userInfo: [NSLocalizedDescriptionKey: "could not build by-address URL"])
    }
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw NSError(
        domain: "CloudAssetDetailClient",
        code: http.statusCode,
        userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? ""])
    }
    return try JSONDecoder().decode(CloudAssetDetail.self, from: data)
  }

  /// Fetch the detail for a server ABSOLUTE path via
  /// `GET /api/assets/by-fspath?path=…`. Used for cloud-BROWSE-opened assets
  /// (`loadCloudDir`), which carry only the abs path — no ObjectId and no
  /// `slug:relPath` address. The server resolves the path to its library and
  /// returns the same DTO (plus the computed `address`). Throws on non-2xx.
  public func detail(fsPath: String) async throws -> CloudAssetDetail {
    var components = URLComponents(
      url: server.appending(path: "/api/assets/by-fspath"),
      resolvingAgainstBaseURL: false)
    components?.queryItems = [URLQueryItem(name: "path", value: fsPath)]
    guard let url = components?.url else {
      throw NSError(
        domain: "CloudAssetDetailClient", code: -1,
        userInfo: [NSLocalizedDescriptionKey: "could not build by-fspath URL"])
    }
    let (data, resp) = try await httpClient.data(for: URLRequest(url: url))
    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw NSError(
        domain: "CloudAssetDetailClient",
        code: http.statusCode,
        userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? ""])
    }
    return try JSONDecoder().decode(CloudAssetDetail.self, from: data)
  }

  /// Sample client for SwiftUI `#Preview` blocks — points at an
  /// unreachable server so requests fail fast and the block stays hidden.
  /// Mirrors `CloudHistogramClient.preview()`.
  public static func preview(
    server: URL = URL(string: "https://preview.maple.invalid")!
  ) -> CloudAssetDetailClient {
    CloudAssetDetailClient(
      server: server,
      httpClient: AuthenticatedHTTPClient.preview(server: server)
    )
  }
}
