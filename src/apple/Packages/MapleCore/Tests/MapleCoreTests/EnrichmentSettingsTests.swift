// EnrichmentSettingsTests.swift
//
// Wire shapes and form rules for the T5a enrichment rows — Describe,
// Transcribe, Geocode, service search (#2771).
//
// The rule that carries real risk is the shared-document merge hazard: the
// PUT is patch/merge against ONE document every row writes to, so a row
// that accidentally serializes another row's key clobbers it with a stale
// value. Every `*_no foreign keys*` test below asserts the exact key set a
// row's patch produces.

import XCTest

@testable import MapleCore

final class EnrichmentConfigDecodeTests: XCTestCase {

  private let sampleJSON = """
    {"nominatim_url":"https://nominatim.example","geocode_worker_enabled":true,
     "nominatim_rate_limit_per_sec":10,"describe_provider_url":"http://localhost:11434",
     "transcribe_model_tier":"medium.en","service_search_rate_limit_per_minute":60}
    """

  func test_decode_fullConfig() throws {
    let cfg = try JSONDecoder().decode(EnrichmentConfig.self, from: Data(sampleJSON.utf8))
    XCTAssertEqual(cfg.nominatimURL, "https://nominatim.example")
    XCTAssertTrue(cfg.geocodeWorkerEnabled)
    XCTAssertEqual(cfg.nominatimRateLimitPerSec, 10)
    XCTAssertEqual(cfg.describeProviderURL, "http://localhost:11434")
    XCTAssertEqual(cfg.transcribeModelTier, .mediumEn)
    XCTAssertEqual(cfg.serviceSearchRateLimitPerMinute, 60)
  }

  func test_decode_ignoresUnmodelledFieldsAndToleratesMissingT5bFields() throws {
    // face_worker_enabled and `source` still aren't modelled here — an
    // unmodelled key must not fail the decode. face_model_dir /
    // face_min_detection_size ARE modelled (T5b, #2772) but omitted from
    // this fixture on purpose, to prove the custom decoder still defaults
    // them instead of throwing keyNotFound on an older/partial response.
    let json = """
      {"nominatim_url":null,"geocode_worker_enabled":true,"nominatim_rate_limit_per_sec":10,
       "describe_provider_url":null,"transcribe_model_tier":"large-v3","service_search_rate_limit_per_minute":60,"face_worker_enabled":false,
       "source":{"nominatim_url":"unset"}}
      """
    let cfg = try JSONDecoder().decode(EnrichmentConfig.self, from: Data(json.utf8))
    XCTAssertEqual(cfg.faceModelDir, "")
    XCTAssertEqual(cfg.faceMinDetectionSize, 0.06)
    XCTAssertNil(cfg.faceModels)
  }

  func test_describeModel_matchesLockedConstant() {
    // The ticket's own body text names `qwen3-vl:8b`, which a comment on
    // #2771 corrects — the real constant is `gemma4:12b`
    // (DESCRIBE_VISION_OLLAMA_TAG, enrichment-config.repo.ts:143). Pin the
    // value here so a future edit to the wrong string fails loudly.
    XCTAssertEqual(EnrichmentModels.describeModel, "gemma4:12b")
  }
}

final class DescribeSettingsFormTests: XCTestCase {

  private func config(describeURL: String? = "http://localhost:11434") -> EnrichmentConfig {
    EnrichmentConfig(
      nominatimURL: "https://nominatim.example", geocodeWorkerEnabled: true,
      nominatimRateLimitPerSec: 10, describeProviderURL: describeURL,
      transcribeModelTier: .mediumEn, serviceSearchRateLimitPerMinute: 60)
  }

  private func encoded(_ patch: DescribeConfigPatch) throws -> [String: Any] {
    let data = try JSONEncoder().encode(patch)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func test_seed_populatesProviderURL() {
    let form = DescribeSettingsForm.seeded(from: config())
    XCTAssertEqual(form.providerURL, "http://localhost:11434")
  }

  func test_patch_sendsOnlyBaseFieldsAndOwnField() throws {
    var form = DescribeSettingsForm.seeded(from: config())
    form.providerURL = "http://ollama.internal:11434"
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertEqual(
      Set(obj.keys), ["nominatim_url", "geocode_worker_enabled", "describe_provider_url"],
      "a describe save must not carry any other row's key")
    XCTAssertEqual(obj["nominatim_url"] as? String, "https://nominatim.example")
    XCTAssertEqual(obj["geocode_worker_enabled"] as? Bool, true)
    XCTAssertEqual(obj["describe_provider_url"] as? String, "http://ollama.internal:11434")
  }

  func test_patch_blankURLSendsExplicitNull() throws {
    // Not write-only like a secret — a cleared field means "clear", so this
    // must serialize as null, not omit the key.
    var form = DescribeSettingsForm.seeded(from: config())
    form.providerURL = "   "
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(obj.keys.contains("describe_provider_url"))
    XCTAssertTrue(obj["describe_provider_url"] is NSNull)
  }
}

final class TranscribeSettingsFormTests: XCTestCase {

  private func config() -> EnrichmentConfig {
    EnrichmentConfig(
      nominatimURL: "https://nominatim.example", geocodeWorkerEnabled: true,
      nominatimRateLimitPerSec: 10, describeProviderURL: nil, transcribeModelTier: .baseEn,
      serviceSearchRateLimitPerMinute: 60)
  }

  func test_seed_populatesTier() {
    XCTAssertEqual(TranscribeSettingsForm.seeded(from: config()).modelTier, .baseEn)
  }

  func test_patch_sendsOnlyBaseFieldsAndOwnField() throws {
    var form = TranscribeSettingsForm.seeded(from: config())
    form.modelTier = .largeV3
    let data = try JSONEncoder().encode(form.patch(echoing: config()))
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(
      Set(obj.keys), ["nominatim_url", "geocode_worker_enabled", "transcribe_model_tier"])
    XCTAssertEqual(obj["transcribe_model_tier"] as? String, "large-v3")
  }
}

final class GeocodeSettingsFormTests: XCTestCase {

  private func config(url: String? = "https://nominatim.example", rate: Double = 10) -> EnrichmentConfig {
    EnrichmentConfig(
      nominatimURL: url, geocodeWorkerEnabled: true, nominatimRateLimitPerSec: rate,
      describeProviderURL: nil, transcribeModelTier: .mediumEn,
      serviceSearchRateLimitPerMinute: 60)
  }

  private func encoded(_ patch: GeocodeConfigPatch) throws -> [String: Any] {
    let data = try JSONEncoder().encode(patch)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func test_seed_populatesURLAndFormattedRate() {
    let form = GeocodeSettingsForm.seeded(from: config(rate: 12.5))
    XCTAssertEqual(form.nominatimURL, "https://nominatim.example")
    XCTAssertEqual(form.rateLimitPerSec, "12.5")
  }

  func test_seed_integerRateHasNoTrailingDecimal() {
    let form = GeocodeSettingsForm.seeded(from: config(rate: 10))
    XCTAssertEqual(form.rateLimitPerSec, "10")
  }

  func test_patch_sendsOnlyBaseFieldsAndOwnFields() throws {
    var form = GeocodeSettingsForm.seeded(from: config())
    form.rateLimitPerSec = "5"
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertEqual(
      Set(obj.keys), ["nominatim_url", "geocode_worker_enabled", "nominatim_rate_limit_per_sec"])
  }

  func test_patch_outOfRangeRateIsSentThroughUnclamped() throws {
    // Unlike the service search budget, geocode does NOT reset out-of-range
    // to null — it sends the typed value and lets the server 400. A 500
    // here (way outside [0.1, 100]) must still appear on the wire as 500.
    var form = GeocodeSettingsForm.seeded(from: config())
    form.rateLimitPerSec = "500"
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertEqual(obj["nominatim_rate_limit_per_sec"] as? Double, 500)
  }

  func test_patch_nonPositiveRateSendsNull() throws {
    var form = GeocodeSettingsForm.seeded(from: config())
    form.rateLimitPerSec = "0"
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(obj["nominatim_rate_limit_per_sec"] is NSNull)
  }

  func test_patch_blankURLSendsExplicitNull() throws {
    var form = GeocodeSettingsForm.seeded(from: config())
    form.nominatimURL = ""
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(obj["nominatim_url"] is NSNull)
  }

  func test_testURL_nilWhenBlank() {
    var form = GeocodeSettingsForm.seeded(from: config())
    form.nominatimURL = "   "
    XCTAssertNil(form.testURL())
  }
}

final class ServiceSearchSettingsFormTests: XCTestCase {

  private func config() -> EnrichmentConfig {
    EnrichmentConfig(
      nominatimURL: "https://nominatim.example", geocodeWorkerEnabled: true,
      nominatimRateLimitPerSec: 10, describeProviderURL: nil, transcribeModelTier: .mediumEn,
      serviceSearchRateLimitPerMinute: 60)
  }

  private func encoded(_ patch: ServiceSearchConfigPatch) throws -> [String: Any] {
    let data = try JSONEncoder().encode(patch)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func test_seed_populatesTheBudget() {
    let form = ServiceSearchSettingsForm.seeded(from: config())
    XCTAssertEqual(form.serviceRateLimitPerMinute, "60")
  }

  func test_patch_sendsOnlyBaseFieldsAndOwnFields() throws {
    let form = ServiceSearchSettingsForm.seeded(from: config())
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertEqual(
      Set(obj.keys),
      ["nominatim_url", "geocode_worker_enabled", "service_search_rate_limit_per_minute"])
  }

  func test_patch_inRangeServiceRateSendsTheValue() throws {
    var form = ServiceSearchSettingsForm.seeded(from: config())
    form.serviceRateLimitPerMinute = " 120 "
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertEqual(obj["service_search_rate_limit_per_minute"] as? Int, 120)
  }

  func test_patch_outOfRangeServiceRateSendsNull() throws {
    var form = ServiceSearchSettingsForm.seeded(from: config())
    form.serviceRateLimitPerMinute = "50000"  // > 10000
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(
      obj["service_search_rate_limit_per_minute"] is NSNull,
      "out-of-range must reset to default, not clamp to the 10000 ceiling")
  }

  func test_patch_zeroServiceRateSendsNull() throws {
    var form = ServiceSearchSettingsForm.seeded(from: config())
    form.serviceRateLimitPerMinute = "0"  // < min of 1
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(obj["service_search_rate_limit_per_minute"] is NSNull)
  }
}

// MARK: - Face-detect / face-embed (T5b, #2772)

final class FaceModelsStatusDecodeTests: XCTestCase {

  func test_decode_fullConfigWithFaceModels() throws {
    let json = """
      {"nominatim_url":"https://nominatim.example","geocode_worker_enabled":true,
       "nominatim_rate_limit_per_sec":10,"describe_provider_url":null,
       "transcribe_model_tier":"medium.en","service_search_rate_limit_per_minute":60,"face_model_dir":"/data/models",
       "face_detector_url":"https://example.com/scrfd_10g.onnx","face_detector_sha256":"abc123",
       "face_recognizer_url":null,"face_recognizer_sha256":null,
       "face_min_detection_size":0.08,
       "face_models":{"status":"loaded","error_detail":null,
         "detector":{"path":"/data/models/scrfd_10g.onnx","present":true,"bytes":16700000},
         "recognizer":{"path":"/data/models/arcface_r100_glint360k.onnx","present":true,"bytes":248000000}}}
      """
    let cfg = try JSONDecoder().decode(EnrichmentConfig.self, from: Data(json.utf8))
    XCTAssertEqual(cfg.faceModelDir, "/data/models")
    XCTAssertEqual(cfg.faceDetectorURL, "https://example.com/scrfd_10g.onnx")
    XCTAssertEqual(cfg.faceDetectorSHA256, "abc123")
    XCTAssertNil(cfg.faceRecognizerURL)
    XCTAssertEqual(cfg.faceMinDetectionSize, 0.08)
    XCTAssertEqual(cfg.faceModels?.status, .loaded)
    XCTAssertEqual(cfg.faceModels?.detector.bytes, 16_700_000)
    XCTAssertTrue(cfg.faceModels?.detector.present ?? false)
    XCTAssertEqual(cfg.faceModels?.recognizer.path, "/data/models/arcface_r100_glint360k.onnx")
  }

  func test_decode_errorStatusCarriesDetail() throws {
    let json = """
      {"status":"error","error_detail":"sha256 mismatch",
       "detector":{"path":"/x/scrfd_10g.onnx","present":false,"bytes":0},
       "recognizer":{"path":"/x/arcface_r100_glint360k.onnx","present":false,"bytes":0}}
      """
    let status = try JSONDecoder().decode(FaceModelsStatus.self, from: Data(json.utf8))
    XCTAssertEqual(status.status, .error)
    XCTAssertEqual(status.errorDetail, "sha256 mismatch")
    XCTAssertFalse(status.detector.present)
  }
}

final class FaceDetectSettingsFormTests: XCTestCase {

  private func config(
    modelDir: String = "/data/models", detectorURL: String? = "https://example.com/scrfd_10g.onnx",
    minSize: Double = 0.06
  ) -> EnrichmentConfig {
    EnrichmentConfig(
      nominatimURL: "https://nominatim.example", geocodeWorkerEnabled: true,
      nominatimRateLimitPerSec: 10, describeProviderURL: nil, transcribeModelTier: .mediumEn,
      serviceSearchRateLimitPerMinute: 60, faceModelDir: modelDir, faceDetectorURL: detectorURL,
      faceDetectorSHA256: "abc123", faceRecognizerURL: "https://example.com/arcface.onnx",
      faceRecognizerSHA256: "def456", faceMinDetectionSize: minSize)
  }

  private func encoded(_ patch: FaceDetectConfigPatch) throws -> [String: Any] {
    let data = try JSONEncoder().encode(patch)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func test_seed_populatesDetectorFieldsOnly() {
    let form = FaceDetectSettingsForm.seeded(from: config())
    XCTAssertEqual(form.modelDir, "/data/models")
    XCTAssertEqual(form.detectorURL, "https://example.com/scrfd_10g.onnx")
    XCTAssertEqual(form.detectorSHA256, "abc123")
    XCTAssertEqual(form.minDetectionSize, "0.06")
  }

  func test_patch_sendsOnlyBaseFieldsAndOwnFields_noRecognizerKeys() throws {
    let form = FaceDetectSettingsForm.seeded(from: config())
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertEqual(
      Set(obj.keys),
      [
        "nominatim_url", "geocode_worker_enabled", "face_model_dir", "face_detector_url",
        "face_detector_sha256", "face_min_detection_size",
      ],
      "a face-detect save must not carry any face_recognizer_* key — that would clobber the "
        + "face-embed row's saved values")
  }

  func test_patch_blankMinSizeSendsNull_notZero() throws {
    var form = FaceDetectSettingsForm.seeded(from: config())
    form.minDetectionSize = ""
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(
      obj["face_min_detection_size"] is NSNull,
      "a blank field must send null — 0 is a valid \"filter off\" value and must never be sent "
        + "unless the operator actually typed it")
  }

  func test_patch_explicitZeroMinSizeSendsZero() throws {
    var form = FaceDetectSettingsForm.seeded(from: config())
    form.minDetectionSize = "0"
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertEqual(obj["face_min_detection_size"] as? Double, 0)
  }

  func test_patch_outOfRangeMinSizeSendsNull() throws {
    var form = FaceDetectSettingsForm.seeded(from: config())
    form.minDetectionSize = "1"  // must be < 1, not <= 1
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(obj["face_min_detection_size"] is NSNull)
  }

  func test_patch_negativeMinSizeSendsNull() throws {
    var form = FaceDetectSettingsForm.seeded(from: config())
    form.minDetectionSize = "-0.1"
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(obj["face_min_detection_size"] is NSNull)
  }

  func test_patch_inRangeMinSizeSendsTheValue() throws {
    var form = FaceDetectSettingsForm.seeded(from: config())
    form.minDetectionSize = "0.2"
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertEqual(obj["face_min_detection_size"] as? Double, 0.2)
  }

  func test_patch_blankModelDirSendsExplicitNull() throws {
    var form = FaceDetectSettingsForm.seeded(from: config())
    form.modelDir = "  "
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(obj["face_model_dir"] is NSNull)
  }

  func test_patch_blankDetectorURLSendsExplicitNull() throws {
    var form = FaceDetectSettingsForm.seeded(from: config())
    form.detectorURL = ""
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(obj["face_detector_url"] is NSNull)
  }
}

final class FaceEmbedSettingsFormTests: XCTestCase {

  private func config() -> EnrichmentConfig {
    EnrichmentConfig(
      nominatimURL: "https://nominatim.example", geocodeWorkerEnabled: true,
      nominatimRateLimitPerSec: 10, describeProviderURL: nil, transcribeModelTier: .mediumEn,
      serviceSearchRateLimitPerMinute: 60, faceModelDir: "/data/models",
      faceDetectorURL: "https://example.com/scrfd_10g.onnx", faceDetectorSHA256: "abc123",
      faceRecognizerURL: "https://example.com/arcface.onnx", faceRecognizerSHA256: "def456",
      faceMinDetectionSize: 0.06)
  }

  private func encoded(_ patch: FaceEmbedConfigPatch) throws -> [String: Any] {
    let data = try JSONEncoder().encode(patch)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func test_seed_populatesRecognizerFieldsOnly() {
    let form = FaceEmbedSettingsForm.seeded(from: config())
    XCTAssertEqual(form.recognizerURL, "https://example.com/arcface.onnx")
    XCTAssertEqual(form.recognizerSHA256, "def456")
  }

  func test_patch_sendsOnlyBaseFieldsAndOwnFields_noDetectorOrModelDirKeys() throws {
    let form = FaceEmbedSettingsForm.seeded(from: config())
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertEqual(
      Set(obj.keys),
      ["nominatim_url", "geocode_worker_enabled", "face_recognizer_url", "face_recognizer_sha256"],
      "a face-embed save must not carry face_model_dir or any face_detector_* key — those belong "
        + "to the face-detect row")
  }

  func test_patch_blankRecognizerURLSendsExplicitNull() throws {
    var form = FaceEmbedSettingsForm.seeded(from: config())
    form.recognizerURL = ""
    let obj = try encoded(form.patch(echoing: config()))
    XCTAssertTrue(obj["face_recognizer_url"] is NSNull)
  }
}
