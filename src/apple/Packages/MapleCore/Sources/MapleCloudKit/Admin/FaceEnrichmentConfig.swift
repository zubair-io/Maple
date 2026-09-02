// FaceEnrichmentConfig.swift — wire types for the two face rows on the
// enrichment page: face-detect (detector) and face-embed (recognizer)
// (T5b, #2772).
//
// Both PUT the same shared `/api/enrichment/config` document EnrichmentConfig
// models. The merge hazard called out in the ticket (workers.component.ts
// :459-526) is why these are two separate patch types rather than one: the
// face-detect row must send only its own detector fields (+ the shared model
// dir, which face-detect owns) and face-embed only its recognizer fields.
// Sending the other row's seeded-at-load values back would clobber whatever
// the other row's own most recent save left in the database.

import Foundation

/// Live face-model loader status + on-disk probe, decoded from the
/// `face_models` object `GET /api/enrichment/config` returns. Powers the
/// status banner on the face-detect/face-embed rows: green "loaded", amber
/// otherwise, with the real file path and size for each model.
public struct FaceModelsStatus: Decodable, Sendable, Equatable {
  public enum LoaderStatus: String, Decodable, Sendable {
    case idle, downloading, loaded, error
  }

  public struct FileProbe: Decodable, Sendable, Equatable {
    public let path: String
    public let present: Bool
    public let bytes: Int

    public init(path: String, present: Bool, bytes: Int) {
      self.path = path
      self.present = present
      self.bytes = bytes
    }
  }

  public let status: LoaderStatus
  public let errorDetail: String?
  public let detector: FileProbe
  public let recognizer: FileProbe

  public init(status: LoaderStatus, errorDetail: String?, detector: FileProbe, recognizer: FileProbe) {
    self.status = status
    self.errorDetail = errorDetail
    self.detector = detector
    self.recognizer = recognizer
  }

  enum CodingKeys: String, CodingKey {
    case status
    case errorDetail = "error_detail"
    case detector
    case recognizer
  }
}

/// Face-detect row. Owns the shared model directory plus the detector's own
/// download URL / sha256 / minimum face size. Never carries a recognizer
/// field — that would clobber the face-embed row's saved values.
public struct FaceDetectConfigPatch: Encodable, Sendable, Equatable {
  public let nominatimURL: String?
  public let geocodeWorkerEnabled: Bool
  /// `nil` sends explicit `null` (clear to default `~/.maple/models/`) — a
  /// blank field means "clear", not "keep", same as the Describe URL.
  public let faceModelDir: String?
  public let faceDetectorURL: String?
  public let faceDetectorSHA256: String?
  /// `nil` sends explicit `null`. A blank input must produce `nil` here, NOT
  /// `0` — `0` is a valid "filter off" value and would silently change
  /// behaviour. See `FaceDetectSettingsForm.patch(echoing:)`.
  public let faceMinDetectionSize: Double?

  public init(
    nominatimURL: String?, geocodeWorkerEnabled: Bool, faceModelDir: String?,
    faceDetectorURL: String?, faceDetectorSHA256: String?, faceMinDetectionSize: Double?
  ) {
    self.nominatimURL = nominatimURL
    self.geocodeWorkerEnabled = geocodeWorkerEnabled
    self.faceModelDir = faceModelDir
    self.faceDetectorURL = faceDetectorURL
    self.faceDetectorSHA256 = faceDetectorSHA256
    self.faceMinDetectionSize = faceMinDetectionSize
  }

  enum CodingKeys: String, CodingKey {
    case nominatimURL = "nominatim_url"
    case geocodeWorkerEnabled = "geocode_worker_enabled"
    case faceModelDir = "face_model_dir"
    case faceDetectorURL = "face_detector_url"
    case faceDetectorSHA256 = "face_detector_sha256"
    case faceMinDetectionSize = "face_min_detection_size"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeNullable(nominatimURL, forKey: .nominatimURL)
    try c.encode(geocodeWorkerEnabled, forKey: .geocodeWorkerEnabled)
    try c.encodeNullable(faceModelDir, forKey: .faceModelDir)
    try c.encodeNullable(faceDetectorURL, forKey: .faceDetectorURL)
    try c.encodeNullable(faceDetectorSHA256, forKey: .faceDetectorSHA256)
    try c.encodeNullable(faceMinDetectionSize, forKey: .faceMinDetectionSize)
  }
}

/// Face-embed row. Recognizer-only — the model directory is owned by the
/// face-detect row and is deliberately never sent from here.
public struct FaceEmbedConfigPatch: Encodable, Sendable, Equatable {
  public let nominatimURL: String?
  public let geocodeWorkerEnabled: Bool
  public let faceRecognizerURL: String?
  public let faceRecognizerSHA256: String?

  public init(
    nominatimURL: String?, geocodeWorkerEnabled: Bool, faceRecognizerURL: String?,
    faceRecognizerSHA256: String?
  ) {
    self.nominatimURL = nominatimURL
    self.geocodeWorkerEnabled = geocodeWorkerEnabled
    self.faceRecognizerURL = faceRecognizerURL
    self.faceRecognizerSHA256 = faceRecognizerSHA256
  }

  enum CodingKeys: String, CodingKey {
    case nominatimURL = "nominatim_url"
    case geocodeWorkerEnabled = "geocode_worker_enabled"
    case faceRecognizerURL = "face_recognizer_url"
    case faceRecognizerSHA256 = "face_recognizer_sha256"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeNullable(nominatimURL, forKey: .nominatimURL)
    try c.encode(geocodeWorkerEnabled, forKey: .geocodeWorkerEnabled)
    try c.encodeNullable(faceRecognizerURL, forKey: .faceRecognizerURL)
    try c.encodeNullable(faceRecognizerSHA256, forKey: .faceRecognizerSHA256)
  }
}
