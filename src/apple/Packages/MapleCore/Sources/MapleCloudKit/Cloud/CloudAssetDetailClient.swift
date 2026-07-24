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

/// Decoded subset of `GET /api/assets/:id` — the enrichment fields the
/// Info panel surfaces. Other DTO keys (exif, place, faces, vision …) are
/// intentionally not modelled; the decoder skips them.
public struct CloudAssetDetail: Decodable, Equatable, Sendable {
  /// qwen3-vl caption from the describe stage. `null`/absent until it runs.
  public let description: String?
  /// Recognised text, mirrored from `vision.text_visible`. Empty string
  /// when the model saw no text; `null`/absent before the stage runs.
  public let ocrText: String?
  /// Speech-to-text from the transcribe stage (video/audio only).
  public let transcript: CloudTranscript?

  private enum CodingKeys: String, CodingKey {
    case description
    case ocrText = "ocr_text"
    case transcript
  }

  public init(description: String?, ocrText: String?, transcript: CloudTranscript?) {
    self.description = description
    self.ocrText = ocrText
    self.transcript = transcript
  }

  /// Presentation projection: trims each field to a non-empty value (or
  /// `nil`) so the view is a straight render with no whitespace logic.
  /// Pure + `Sendable`, so it is unit-tested directly.
  public var sections: CloudEnrichmentSections {
    CloudEnrichmentSections(
      description: Self.nonEmpty(description),
      ocrText: Self.nonEmpty(ocrText),
      transcriptText: Self.nonEmpty(transcript?.text),
      transcriptFooter: transcript.flatMap { Self.footer(language: $0.language, model: $0.model) }
    )
  }

  private static func nonEmpty(_ s: String?) -> String? {
    guard let trimmed = s?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
    else { return nil }
    return trimmed
  }

  /// `"en · whisper-base"`, dropping either part when blank; `nil` when
  /// both are blank.
  private static func footer(language: String, model: String) -> String? {
    let parts = [language, model]
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
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

  public init(
    description: String?,
    ocrText: String?,
    transcriptText: String?,
    transcriptFooter: String?
  ) {
    self.description = description
    self.ocrText = ocrText
    self.transcriptText = transcriptText
    self.transcriptFooter = transcriptFooter
  }

  public var isEmpty: Bool {
    description == nil && ocrText == nil && transcriptText == nil
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
