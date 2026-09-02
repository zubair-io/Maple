// EnrichmentSettingsForms.swift — editable state for the four T5a rows
// (Describe, Transcribe, Geocode, Meilisearch).
//
// Free of SwiftUI so the merge-hazard and reset-vs-clamp rules below are
// unit-testable; XCUITest is unavailable on the primary dev machine
// (#2525), so anything left in the view is effectively unverifiable. Each
// form's `patch(echoing:)` takes the last-loaded `EnrichmentConfig`
// snapshot so it can supply the two fields the PUT requires on every save
// (see EnrichmentConfig.swift's file comment) without the caller wiring
// that up at every call site.

import Foundation

private func nilIfBlank(_ value: String) -> String? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

// MARK: - Describe

public struct DescribeSettingsForm: Equatable, Sendable {
  public var providerURL: String

  public init(providerURL: String = "") {
    self.providerURL = providerURL
  }

  public static func seeded(from config: EnrichmentConfig) -> DescribeSettingsForm {
    DescribeSettingsForm(providerURL: config.describeProviderURL ?? "")
  }

  public func patch(echoing config: EnrichmentConfig) -> DescribeConfigPatch {
    DescribeConfigPatch(
      nominatimURL: config.nominatimURL,
      geocodeWorkerEnabled: config.geocodeWorkerEnabled,
      describeProviderURL: nilIfBlank(providerURL))
  }

  /// URL for the Test button. Unlike Geocode/Meilisearch, there is no
  /// blank-URL guard on this row (mirrors `workers.component.ts`'s
  /// `testConnection`, which never disables Describe's Test button) — a
  /// blank field is valid input that lets the server fall back to its own
  /// default Ollama endpoint, so this always returns a probeable value.
  public func testProviderURL() -> String? {
    nilIfBlank(providerURL)
  }
}

// MARK: - Transcribe

public struct TranscribeSettingsForm: Equatable, Sendable {
  public var modelTier: WhisperModelTier

  public init(modelTier: WhisperModelTier = .mediumEn) {
    self.modelTier = modelTier
  }

  public static func seeded(from config: EnrichmentConfig) -> TranscribeSettingsForm {
    TranscribeSettingsForm(modelTier: config.transcribeModelTier)
  }

  public func patch(echoing config: EnrichmentConfig) -> TranscribeConfigPatch {
    TranscribeConfigPatch(
      nominatimURL: config.nominatimURL,
      geocodeWorkerEnabled: config.geocodeWorkerEnabled,
      transcribeModelTier: modelTier)
  }
}

// MARK: - Geocode

public struct GeocodeSettingsForm: Equatable, Sendable {
  public var nominatimURL: String
  /// Free text rather than `Double` so a blank field is representable and
  /// distinguishable from `0` while the operator is mid-edit.
  public var rateLimitPerSec: String

  public init(nominatimURL: String = "", rateLimitPerSec: String = "") {
    self.nominatimURL = nominatimURL
    self.rateLimitPerSec = rateLimitPerSec
  }

  public static func seeded(from config: EnrichmentConfig) -> GeocodeSettingsForm {
    GeocodeSettingsForm(
      nominatimURL: config.nominatimURL ?? "",
      rateLimitPerSec: Self.formatted(config.nominatimRateLimitPerSec))
  }

  /// Builds the PUT body for this row. See `GeocodeConfigPatch
  /// .nominatimRateLimitPerSec`'s doc comment for why an out-of-range rate
  /// is sent through as typed rather than reset to `null` here — that rule
  /// is specific to the three Meilisearch numerics.
  public func patch(echoing config: EnrichmentConfig) -> GeocodeConfigPatch {
    GeocodeConfigPatch(
      nominatimURL: nilIfBlank(nominatimURL),
      geocodeWorkerEnabled: config.geocodeWorkerEnabled,
      nominatimRateLimitPerSec: Self.sanitizedRate(rateLimitPerSec))
  }

  /// Credentials for the Test button, or nil when there's no URL to probe —
  /// mirrors `workers.component.ts`'s client-side "Enter a URL to test."
  /// guard for the geocode row.
  public func testURL() -> String? {
    nilIfBlank(nominatimURL)
  }

  private static func sanitizedRate(_ text: String) -> Double? {
    guard let parsed = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)),
      parsed.isFinite, parsed > 0
    else { return nil }
    return parsed
  }

  private static func formatted(_ value: Double) -> String {
    value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
  }
}

// MARK: - Face-detect

/// Detector row (T5b, #2772). Owns the shared model directory plus the
/// detector's own download URL / sha256 / minimum face size.
public struct FaceDetectSettingsForm: Equatable, Sendable {
  public var modelDir: String
  public var detectorURL: String
  public var detectorSHA256: String
  /// Free text so a blank field is representable and distinguishable from
  /// `0` while the operator is mid-edit — `0` is a valid "filter off" value.
  public var minDetectionSize: String

  public init(
    modelDir: String = "", detectorURL: String = "", detectorSHA256: String = "",
    minDetectionSize: String = ""
  ) {
    self.modelDir = modelDir
    self.detectorURL = detectorURL
    self.detectorSHA256 = detectorSHA256
    self.minDetectionSize = minDetectionSize
  }

  public static func seeded(from config: EnrichmentConfig) -> FaceDetectSettingsForm {
    FaceDetectSettingsForm(
      modelDir: config.faceModelDir,
      detectorURL: config.faceDetectorURL ?? "",
      detectorSHA256: config.faceDetectorSHA256 ?? "",
      minDetectionSize: Self.formatted(config.faceMinDetectionSize))
  }

  /// Builds the PUT body. `minDetectionSize` resolves to `nil` (explicit
  /// `null`) for BOTH a blank field and an out-of-range value — never `0`
  /// unless the operator actually typed `0`, since a blank field silently
  /// becoming `0` would turn the size filter off without the operator
  /// noticing.
  public func patch(echoing config: EnrichmentConfig) -> FaceDetectConfigPatch {
    FaceDetectConfigPatch(
      nominatimURL: config.nominatimURL,
      geocodeWorkerEnabled: config.geocodeWorkerEnabled,
      faceModelDir: nilIfBlank(modelDir),
      faceDetectorURL: nilIfBlank(detectorURL),
      faceDetectorSHA256: nilIfBlank(detectorSHA256),
      faceMinDetectionSize: Self.sanitizedMinSize(minDetectionSize))
  }

  private static func sanitizedMinSize(_ text: String) -> Double? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let value = Double(trimmed), value.isFinite,
      EnrichmentLimits.faceMinDetectionSize.contains(value)
    else { return nil }
    return value
  }

  private static func formatted(_ value: Double) -> String {
    value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
  }
}

// MARK: - Face-embed

/// Recognizer row (T5b, #2772). Never carries the model directory — that
/// field belongs to the face-detect row.
public struct FaceEmbedSettingsForm: Equatable, Sendable {
  public var recognizerURL: String
  public var recognizerSHA256: String

  public init(recognizerURL: String = "", recognizerSHA256: String = "") {
    self.recognizerURL = recognizerURL
    self.recognizerSHA256 = recognizerSHA256
  }

  public static func seeded(from config: EnrichmentConfig) -> FaceEmbedSettingsForm {
    FaceEmbedSettingsForm(
      recognizerURL: config.faceRecognizerURL ?? "",
      recognizerSHA256: config.faceRecognizerSHA256 ?? "")
  }

  public func patch(echoing config: EnrichmentConfig) -> FaceEmbedConfigPatch {
    FaceEmbedConfigPatch(
      nominatimURL: config.nominatimURL,
      geocodeWorkerEnabled: config.geocodeWorkerEnabled,
      faceRecognizerURL: nilIfBlank(recognizerURL),
      faceRecognizerSHA256: nilIfBlank(recognizerSHA256))
  }
}

// MARK: - Meilisearch

public struct MeilisearchSettingsForm: Equatable, Sendable {
  public var url: String
  /// Always starts blank — write-only, never echoed back by the server. A
  /// blank value at save time OMITS the field so the stored key survives
  /// (see `MeilisearchConfigPatch.meilisearchAPIKey`).
  public var apiKey: String
  public var semanticEnabled: Bool
  public var embedderModel: String
  public var taskTimeoutSeconds: String
  public var semanticRatio: String
  public var serviceRateLimitPerMinute: String

  public init(
    url: String = "", apiKey: String = "", semanticEnabled: Bool = false, embedderModel: String = "",
    taskTimeoutSeconds: String = "", semanticRatio: String = "", serviceRateLimitPerMinute: String = ""
  ) {
    self.url = url
    self.apiKey = apiKey
    self.semanticEnabled = semanticEnabled
    self.embedderModel = embedderModel
    self.taskTimeoutSeconds = taskTimeoutSeconds
    self.semanticRatio = semanticRatio
    self.serviceRateLimitPerMinute = serviceRateLimitPerMinute
  }

  public static func seeded(from config: EnrichmentConfig) -> MeilisearchSettingsForm {
    MeilisearchSettingsForm(
      url: config.meilisearchURL ?? "",
      apiKey: "",
      semanticEnabled: config.meilisearchSemanticEnabled,
      embedderModel: config.meilisearchEmbedderModel,
      taskTimeoutSeconds: String(config.meilisearchTaskTimeoutSeconds),
      semanticRatio: String(config.meilisearchSemanticRatio),
      serviceRateLimitPerMinute: String(config.serviceSearchRateLimitPerMinute))
  }

  /// Builds the PUT body. The three numerics each resolve to `nil` (sent as
  /// explicit `null`, resetting to the server's default) when unparsable or
  /// outside `EnrichmentLimits` — never clamped to the nearest edge, so a
  /// fat-fingered 999999 doesn't silently become 3600.
  public func patch(echoing config: EnrichmentConfig) -> MeilisearchConfigPatch {
    let trimmedKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    return MeilisearchConfigPatch(
      nominatimURL: config.nominatimURL,
      geocodeWorkerEnabled: config.geocodeWorkerEnabled,
      meilisearchURL: nilIfBlank(url),
      meilisearchAPIKey: trimmedKey.isEmpty ? nil : trimmedKey,
      meilisearchSemanticEnabled: semanticEnabled,
      meilisearchEmbedderModel: nilIfBlank(embedderModel),
      meilisearchTaskTimeoutSeconds: Self.rangedInt(
        taskTimeoutSeconds, in: EnrichmentLimits.meilisearchTaskTimeoutSeconds),
      meilisearchSemanticRatio: Self.rangedDouble(
        semanticRatio, in: EnrichmentLimits.meilisearchSemanticRatio),
      serviceSearchRateLimitPerMinute: Self.rangedInt(
        serviceRateLimitPerMinute, in: EnrichmentLimits.serviceSearchRateLimitPerMinute))
  }

  /// URL + key for the Test button, or nil when there's no URL to probe —
  /// mirrors `workers.component.ts`'s "Enter a URL to test." guard for the
  /// meili row. The key is optional even when present: a blank field lets
  /// the server fall back to the saved key.
  public func testCredentials() -> (url: String, apiKey: String?)? {
    guard let trimmedURL = nilIfBlank(url) else { return nil }
    return (trimmedURL, nilIfBlank(apiKey))
  }

  private static func rangedInt(_ text: String, in range: ClosedRange<Int>) -> Int? {
    guard let value = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)), range.contains(value)
    else { return nil }
    return value
  }

  private static func rangedDouble(_ text: String, in range: ClosedRange<Double>) -> Double? {
    guard let value = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)), value.isFinite,
      range.contains(value)
    else { return nil }
    return value
  }
}
