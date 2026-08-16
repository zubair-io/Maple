// EnrichmentConfig.swift — wire types for /api/enrichment/config (T5a).
//
// Configures the four service-backed enrichment stages: Describe,
// Transcribe, Geocode, Meilisearch (src/api/src/routes/enrichment.ts). Face
// models and the maintenance panels are #2772 (T5b) and deliberately absent
// here — this file only models what T5a's rows read and write.
//
// The PUT is patch/merge against ONE shared document that every enrichment
// row writes to. `ConfigBody` in enrichment.ts marks exactly two fields
// non-optional — `nominatim_url` and `geocode_worker_enabled` — every other
// field is `t.Optional` and, when omitted, leaves the corresponding DB value
// untouched. Every patch type below therefore carries those two fields
// unconditionally (echoed from the last-loaded snapshot unless the row IS
// the geocode row) alongside only the field(s) that row owns. This is not a
// violation of "send only your row's fields" — it's two required passthrough
// fields the server demands on every write, not a foreign-key write.

import Foundation

/// Effective config as GET returns it: DB row, env var, or built-in default
/// already resolved server-side (`resolveEnrichmentConfig` in
/// enrichment-config.resolve.ts). Only the fields T5a's four rows read.
public struct EnrichmentConfig: Decodable, Sendable, Equatable {
  public let nominatimURL: String?
  public let geocodeWorkerEnabled: Bool
  public let nominatimRateLimitPerSec: Double
  public let describeProviderURL: String?
  public let transcribeModelTier: WhisperModelTier
  public let meilisearchURL: String?
  /// Whether a Meilisearch API key is configured (DB or env). The key
  /// itself is a secret and is stripped server-side before the response —
  /// only this boolean crosses the wire (`toPublicConfig` in enrichment.ts).
  public let meilisearchAPIKeySet: Bool
  public let meilisearchTaskTimeoutSeconds: Int
  public let meilisearchSemanticEnabled: Bool
  /// Read-only mirror shown on the Meilisearch row: the Ollama endpoint
  /// Meilisearch's embedder actually calls. Always Describe's resolved URL
  /// server-side (`meilisearchEmbedderUrl` in enrichment-config.resolve.ts)
  /// — Maple owns both configs and refuses to let them drift apart.
  public let meilisearchEmbedderURL: String
  public let meilisearchEmbedderModel: String
  public let meilisearchSemanticRatio: Double
  public let serviceSearchRateLimitPerMinute: Int

  public init(
    nominatimURL: String?, geocodeWorkerEnabled: Bool, nominatimRateLimitPerSec: Double,
    describeProviderURL: String?, transcribeModelTier: WhisperModelTier, meilisearchURL: String?,
    meilisearchAPIKeySet: Bool, meilisearchTaskTimeoutSeconds: Int, meilisearchSemanticEnabled: Bool,
    meilisearchEmbedderURL: String, meilisearchEmbedderModel: String, meilisearchSemanticRatio: Double,
    serviceSearchRateLimitPerMinute: Int
  ) {
    self.nominatimURL = nominatimURL
    self.geocodeWorkerEnabled = geocodeWorkerEnabled
    self.nominatimRateLimitPerSec = nominatimRateLimitPerSec
    self.describeProviderURL = describeProviderURL
    self.transcribeModelTier = transcribeModelTier
    self.meilisearchURL = meilisearchURL
    self.meilisearchAPIKeySet = meilisearchAPIKeySet
    self.meilisearchTaskTimeoutSeconds = meilisearchTaskTimeoutSeconds
    self.meilisearchSemanticEnabled = meilisearchSemanticEnabled
    self.meilisearchEmbedderURL = meilisearchEmbedderURL
    self.meilisearchEmbedderModel = meilisearchEmbedderModel
    self.meilisearchSemanticRatio = meilisearchSemanticRatio
    self.serviceSearchRateLimitPerMinute = serviceSearchRateLimitPerMinute
  }

  enum CodingKeys: String, CodingKey {
    case nominatimURL = "nominatim_url"
    case geocodeWorkerEnabled = "geocode_worker_enabled"
    case nominatimRateLimitPerSec = "nominatim_rate_limit_per_sec"
    case describeProviderURL = "describe_provider_url"
    case transcribeModelTier = "transcribe_model_tier"
    case meilisearchURL = "meilisearch_url"
    case meilisearchAPIKeySet = "meilisearch_api_key_set"
    case meilisearchTaskTimeoutSeconds = "meilisearch_task_timeout_seconds"
    case meilisearchSemanticEnabled = "meilisearch_semantic_enabled"
    case meilisearchEmbedderURL = "meilisearch_embedder_url"
    case meilisearchEmbedderModel = "meilisearch_embedder_model"
    case meilisearchSemanticRatio = "meilisearch_semantic_ratio"
    case serviceSearchRateLimitPerMinute = "service_search_rate_limit_per_minute"
  }
}

/// Whisper model tier for the Transcribe row. Mirrors `WHISPER_MODEL_TIERS`
/// in `workers.vm.ts` and the `transcribe_model_tier` literal union in
/// `ConfigBody` (enrichment.ts).
public enum WhisperModelTier: String, Codable, CaseIterable, Identifiable, Sendable {
  case tinyEn = "tiny.en"
  case baseEn = "base.en"
  case smallEn = "small.en"
  case mediumEn = "medium.en"
  case largeV3 = "large-v3"

  public var id: String { rawValue }
}

/// Locked-in-code model constants. Single source of truth on the Apple side
/// so the read-only Describe row can't drift from the server's actual
/// behaviour.
public enum EnrichmentModels {
  /// Mirrors `DESCRIBE_VISION_OLLAMA_TAG` at
  /// `src/api/src/enrichment/enrichment-config.repo.ts:143`, which
  /// `describe.ts:81` binds to `FIXED_DESCRIBE_MODEL`. The describe stage
  /// rejects any other model's output shape, so this is not configurable —
  /// #2771's own ticket text names `qwen3-vl:8b`, which is stale; verify
  /// against the constant above before ever changing this literal.
  public static let describeModel = "gemma4:12b"
}

/// Client-side range mirrors of the server's validation bounds
/// (`enrichment-config.repo.ts`). Server-side validation is authoritative;
/// these exist so the form can decide, per field, whether to send a typed
/// value or reset to default (`null`) before the request ever leaves.
public enum EnrichmentLimits {
  /// `MIN_NOMINATIM_RATE_LIMIT_PER_SEC` / `MAX_NOMINATIM_RATE_LIMIT_PER_SEC`.
  public static let nominatimRateLimitPerSec = 0.1...100.0
  /// `MIN_MEILISEARCH_TASK_TIMEOUT_SECONDS` / `MAX_...`.
  public static let meilisearchTaskTimeoutSeconds = 30...3600
  public static let meilisearchSemanticRatio = 0.0...1.0
  /// `MIN_SERVICE_SEARCH_RATE_LIMIT_PER_MINUTE` / `MAX_...`. The web form
  /// (`workers.component.ts`) only checks `> 0` and leaves the upper bound
  /// to the server; this enforces both bounds client-side, which matches
  /// the server's actual validation exactly and is stricter than the web.
  public static let serviceSearchRateLimitPerMinute = 1...10_000
}

// MARK: - Patches

/// Describe row (#2771). Only the Ollama URL is editable — the model is
/// locked in code (`EnrichmentModels.describeModel`) and never sent.
public struct DescribeConfigPatch: Encodable, Sendable, Equatable {
  public let nominatimURL: String?
  public let geocodeWorkerEnabled: Bool
  /// `nil` sends an explicit `null`, clearing back to env/default — unlike
  /// the Cloudflare/Meilisearch secrets, this isn't write-only, so a blank
  /// field means "clear", not "keep".
  public let describeProviderURL: String?

  public init(nominatimURL: String?, geocodeWorkerEnabled: Bool, describeProviderURL: String?) {
    self.nominatimURL = nominatimURL
    self.geocodeWorkerEnabled = geocodeWorkerEnabled
    self.describeProviderURL = describeProviderURL
  }

  enum CodingKeys: String, CodingKey {
    case nominatimURL = "nominatim_url"
    case geocodeWorkerEnabled = "geocode_worker_enabled"
    case describeProviderURL = "describe_provider_url"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeNullable(nominatimURL, forKey: .nominatimURL)
    try c.encode(geocodeWorkerEnabled, forKey: .geocodeWorkerEnabled)
    try c.encodeNullable(describeProviderURL, forKey: .describeProviderURL)
  }
}

/// Transcribe row. A single picker — always sends one of the five tiers.
public struct TranscribeConfigPatch: Encodable, Sendable, Equatable {
  public let nominatimURL: String?
  public let geocodeWorkerEnabled: Bool
  public let transcribeModelTier: WhisperModelTier

  public init(nominatimURL: String?, geocodeWorkerEnabled: Bool, transcribeModelTier: WhisperModelTier) {
    self.nominatimURL = nominatimURL
    self.geocodeWorkerEnabled = geocodeWorkerEnabled
    self.transcribeModelTier = transcribeModelTier
  }

  enum CodingKeys: String, CodingKey {
    case nominatimURL = "nominatim_url"
    case geocodeWorkerEnabled = "geocode_worker_enabled"
    case transcribeModelTier = "transcribe_model_tier"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeNullable(nominatimURL, forKey: .nominatimURL)
    try c.encode(geocodeWorkerEnabled, forKey: .geocodeWorkerEnabled)
    try c.encode(transcribeModelTier, forKey: .transcribeModelTier)
  }
}

/// Geocode row. `nominatimURL` here IS the row's own edited field, not a
/// passthrough echo — this is the one row where the "required base field"
/// and "row-owned field" are the same field.
public struct GeocodeConfigPatch: Encodable, Sendable, Equatable {
  public let nominatimURL: String?
  public let geocodeWorkerEnabled: Bool
  /// `nil` sends an explicit `null` (clear to env/default). Always present,
  /// never omitted. Unlike the three Meilisearch numerics below, an
  /// out-of-range value here is NOT reset to null client-side — it is sent
  /// through as typed and the server 400s the whole save
  /// (`MIN_NOMINATIM_RATE_LIMIT_PER_SEC` / `MAX_...` in
  /// enrichment-config.repo.ts). This mirrors `workers.component.ts`'s
  /// geocode branch, which only checks "finite and positive" and leaves
  /// range validation to the server.
  public let nominatimRateLimitPerSec: Double?

  public init(nominatimURL: String?, geocodeWorkerEnabled: Bool, nominatimRateLimitPerSec: Double?) {
    self.nominatimURL = nominatimURL
    self.geocodeWorkerEnabled = geocodeWorkerEnabled
    self.nominatimRateLimitPerSec = nominatimRateLimitPerSec
  }

  enum CodingKeys: String, CodingKey {
    case nominatimURL = "nominatim_url"
    case geocodeWorkerEnabled = "geocode_worker_enabled"
    case nominatimRateLimitPerSec = "nominatim_rate_limit_per_sec"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeNullable(nominatimURL, forKey: .nominatimURL)
    try c.encode(geocodeWorkerEnabled, forKey: .geocodeWorkerEnabled)
    try c.encodeNullable(nominatimRateLimitPerSec, forKey: .nominatimRateLimitPerSec)
  }
}

/// Meilisearch row. Carries two rules from `meilisearchFormToPatch`
/// (`workers.vm.ts:273`): the API key is write-only and OMITTED when blank
/// (never sent as null — there is no "clear" affordance on this row), while
/// the three numeric fields reset to `null` (not a clamped edge value) when
/// out of range.
public struct MeilisearchConfigPatch: Encodable, Sendable, Equatable {
  public let nominatimURL: String?
  public let geocodeWorkerEnabled: Bool
  public let meilisearchURL: String?
  /// `nil` OMITS the key entirely so the stored key survives. A blank form
  /// field must never serialize to explicit `null` here — that would clear
  /// a working key on every unrelated save.
  public let meilisearchAPIKey: String?
  public let meilisearchSemanticEnabled: Bool
  public let meilisearchEmbedderModel: String?
  /// `nil` sends explicit `null` (reset to default) when out of
  /// `EnrichmentLimits.meilisearchTaskTimeoutSeconds`. Always present.
  public let meilisearchTaskTimeoutSeconds: Int?
  /// `nil` sends explicit `null` when out of
  /// `EnrichmentLimits.meilisearchSemanticRatio`. Always present.
  public let meilisearchSemanticRatio: Double?
  /// `nil` sends explicit `null` when out of
  /// `EnrichmentLimits.serviceSearchRateLimitPerMinute`. Always present.
  public let serviceSearchRateLimitPerMinute: Int?

  public init(
    nominatimURL: String?, geocodeWorkerEnabled: Bool, meilisearchURL: String?,
    meilisearchAPIKey: String?, meilisearchSemanticEnabled: Bool, meilisearchEmbedderModel: String?,
    meilisearchTaskTimeoutSeconds: Int?, meilisearchSemanticRatio: Double?,
    serviceSearchRateLimitPerMinute: Int?
  ) {
    self.nominatimURL = nominatimURL
    self.geocodeWorkerEnabled = geocodeWorkerEnabled
    self.meilisearchURL = meilisearchURL
    self.meilisearchAPIKey = meilisearchAPIKey
    self.meilisearchSemanticEnabled = meilisearchSemanticEnabled
    self.meilisearchEmbedderModel = meilisearchEmbedderModel
    self.meilisearchTaskTimeoutSeconds = meilisearchTaskTimeoutSeconds
    self.meilisearchSemanticRatio = meilisearchSemanticRatio
    self.serviceSearchRateLimitPerMinute = serviceSearchRateLimitPerMinute
  }

  enum CodingKeys: String, CodingKey {
    case nominatimURL = "nominatim_url"
    case geocodeWorkerEnabled = "geocode_worker_enabled"
    case meilisearchURL = "meilisearch_url"
    case meilisearchAPIKey = "meilisearch_api_key"
    case meilisearchSemanticEnabled = "meilisearch_semantic_enabled"
    case meilisearchEmbedderModel = "meilisearch_embedder_model"
    case meilisearchTaskTimeoutSeconds = "meilisearch_task_timeout_seconds"
    case meilisearchSemanticRatio = "meilisearch_semantic_ratio"
    case serviceSearchRateLimitPerMinute = "service_search_rate_limit_per_minute"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeNullable(nominatimURL, forKey: .nominatimURL)
    try c.encode(geocodeWorkerEnabled, forKey: .geocodeWorkerEnabled)
    try c.encodeNullable(meilisearchURL, forKey: .meilisearchURL)
    // OMIT, not null-encode — the one field in this file with keep/blank
    // semantics rather than clear/blank semantics.
    try c.encodeIfPresent(meilisearchAPIKey, forKey: .meilisearchAPIKey)
    try c.encode(meilisearchSemanticEnabled, forKey: .meilisearchSemanticEnabled)
    try c.encodeNullable(meilisearchEmbedderModel, forKey: .meilisearchEmbedderModel)
    try c.encodeNullable(meilisearchTaskTimeoutSeconds, forKey: .meilisearchTaskTimeoutSeconds)
    try c.encodeNullable(meilisearchSemanticRatio, forKey: .meilisearchSemanticRatio)
    try c.encodeNullable(
      serviceSearchRateLimitPerMinute, forKey: .serviceSearchRateLimitPerMinute)
  }
}

extension KeyedEncodingContainer {
  /// Encodes `value` for `key`, writing JSON `null` when it's `nil` rather
  /// than omitting the key. The enrichment-config PUT distinguishes
  /// "omitted" (leave unchanged) from "null" (reset to default) for most
  /// fields, so the auto-synthesized Encodable behaviour — which omits `nil`
  /// optionals — is wrong for them; every patch type above calls this
  /// explicitly for every field except the one that genuinely wants omit
  /// (the Meilisearch API key).
  mutating func encodeNullable<T: Encodable>(_ value: T?, forKey key: Key) throws {
    if let value {
      try encode(value, forKey: key)
    } else {
      try encodeNil(forKey: key)
    }
  }
}

/// Shared response shape for the three `POST /api/enrichment/test*` probes.
/// All three report failure as `{ok: false, error}` on a 2xx status — only
/// request-shape problems (an empty URL, an unknown provider) use 4xx. A
/// caller that only checks the HTTP status will read a failed health check
/// as a success; `EnrichmentConfigClient` layers this `ok` check on top of
/// the usual status handling for exactly that reason.
struct EnrichmentTestResult: Decodable, Sendable {
  let ok: Bool
  let error: String?
}
