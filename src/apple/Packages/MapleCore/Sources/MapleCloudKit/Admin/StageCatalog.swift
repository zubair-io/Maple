// StageCatalog.swift — Swift port of the stage metadata and derivations in
// src/web/projects/maple/src/app/settings/workers/workers.vm.ts.
//
// Pure data and pure functions, so the same rules the web is tested on are
// testable here rather than being re-derived inside a SwiftUI body.

import Foundation

public enum StageGroup: String, Sendable, Equatable, CaseIterable {
  case ingest = "Ingest"
  case enrich = "Enrich"
  case index = "Index"
}

public struct StageMeta: Sendable, Equatable {
  public let group: StageGroup
  /// SF Symbol. The web's icon set doesn't map 1:1, so these are the
  /// nearest system equivalents rather than a mechanical translation.
  public let icon: String
  public let description: String

  public init(group: StageGroup, icon: String, description: String) {
    self.group = group
    self.icon = icon
    self.description = description
  }
}

public enum StageCatalog {

  /// Known stages. Deliberately not exhaustive over what a server might
  /// run — see `meta(for:)`.
  public static let known: [String: StageMeta] = [
    "hash": StageMeta(
      group: .ingest, icon: "number",
      description: "Computes a content hash for each new asset; deduplicates on ingest."),
    "exif": StageMeta(
      group: .ingest, icon: "camera.aperture",
      description: "Extracts EXIF/XMP metadata: camera, lens, exposure, GPS, dates."),
    "thumb": StageMeta(
      group: .ingest, icon: "photo",
      description: "Generates 256-px grid thumbnails and stores them in the thumb cache."),
    "preview": StageMeta(
      group: .ingest, icon: "photo.on.rectangle",
      description:
        "Builds the 1280-px preview cache used by the editor and enrichment. Concurrency also caps on-demand regeneration from cache-miss preview requests."),
    "describe": StageMeta(
      group: .enrich, icon: "sparkles",
      description:
        "Local vision-LLM via Ollama. Runs a multimodal model against the preview cache and produces a structured caption plus OCR text."),
    "transcribe": StageMeta(
      group: .enrich, icon: "waveform",
      description: "Transcribes speech in video and audio files with whisper.cpp on the CPU."),
    "geocode": StageMeta(
      group: .enrich, icon: "globe",
      description:
        "Reverse-geocodes EXIF GPS coordinates against a self-hosted Nominatim instance."),
    "face-detect": StageMeta(
      group: .enrich, icon: "face.smiling",
      description:
        "Detects faces in cached thumbnails with the SCRFD-10G ONNX detector, emitting bounding boxes and landmarks."),
    "face-embed": StageMeta(
      group: .enrich, icon: "person.crop.square",
      description: "Computes face embeddings used to cluster detections into people."),
    "meili": StageMeta(
      group: .index, icon: "magnifyingglass",
      description: "Indexes assets into Meilisearch for full-text and semantic search."),
    "cf-thumb-sync": StageMeta(
      group: .index, icon: "cloud",
      description: "Mirrors thumbnails to the Cloudflare R2 bucket configured under Cloudflare."),
    "migration": StageMeta(
      group: .index, icon: "arrow.triangle.2.circlepath",
      description: "Runs one-off data migrations across existing assets."),
    "deduplicate": StageMeta(
      group: .index, icon: "square.on.square",
      description: "Finds and reconciles duplicate assets already in the library."),
  ]

  /// Metadata for `name`, synthesising an entry for stages this build has
  /// never heard of.
  ///
  /// The fallback is load-bearing rather than defensive: a stage newly
  /// registered on the server must appear in the table without an Apple
  /// release. It lands in Ingest with a generic icon, matching the web.
  public static func meta(for name: String) -> StageMeta {
    known[name]
      ?? StageMeta(group: .ingest, icon: "gearshape.2", description: "")
  }

  /// Stages bucketed into the fixed pipeline order. Empty groups are kept
  /// so the table's section order doesn't shift as stages come and go.
  public static func grouped(
    _ stages: [StageStatus]
  ) -> [(group: StageGroup, rows: [StageStatus])] {
    StageGroup.allCases.map { group in
      (group: group, rows: stages.filter { meta(for: $0.name).group == group })
    }
  }

  public struct Summary: Sendable, Equatable {
    public let running: Int
    public let paused: Int
    public let dead: Int
    public let pending: Int

    public init(running: Int, paused: Int, dead: Int, pending: Int) {
      self.running = running
      self.paused = paused
      self.dead = dead
      self.pending = pending
    }
  }

  /// Header chips. `running`/`paused` count stages; `dead`/`pending` sum
  /// jobs — the two halves are deliberately different units, matching the
  /// web.
  public static func summarize(_ stages: [StageStatus]) -> Summary {
    Summary(
      running: stages.filter { $0.status == .running }.count,
      paused: stages.filter { $0.status == .paused }.count,
      dead: stages.reduce(0) { $0 + $1.dead },
      pending: stages.reduce(0) { $0 + $1.pending })
  }

  public static func statusLabel(_ state: StageRunState) -> String {
    switch state {
    case .running: return "Running"
    case .paused: return "Paused"
    case .error: return "Error"
    case .starting: return "Starting"
    case .restarting: return "Restarting"
    case .stopped: return "Stopped"
    case .unknown: return "Unknown"
    }
  }

  /// Tooltip for the ready/blocked column.
  ///
  /// "Blocked" means an upstream stage hasn't produced what this one needs,
  /// not that anything is wrong — worth spelling out, because a large
  /// blocked count otherwise reads as a fault.
  public static func pendingDetail(_ stage: StageStatus) -> String {
    guard stage.blocked != 0 else { return "\(stage.ready) ready to run" }
    return
      "\(stage.ready) ready · \(stage.blocked) blocked on an upstream stage · \(stage.pending) pending total"
  }
}
