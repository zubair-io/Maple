import AppKit
import Observation

@MainActor @Observable
final class LabState {
  var photo: Photo?
  var strokes: [Stroke] = []
  var redo: [Stroke] = []
  var brush = "remove"
  var radius = 0.012
  var prompt =
    "Remove the selected object and its shadow. Reconstruct the background naturally, matching surrounding structure, texture, lighting and perspective. Preserve everything outside the selection. Leave the removed area empty."
  var message = "Open a RAW photo to start."
  var busy = false
  var experiment: Experiment?
  var showResults = false
  var selectedModel = "lama"
  var preferredModel: String?
  var original = false
  var actualSize = false
  var profile = "auto"
  var exposure = 0
  var whiteBalance = 0
  var sourceFolder: URL?
  var jobFolder: URL?
  private var revision = 0
  private let disk = ResearchDisk()
  private var task: Task<Void, Never>?
  private var runtime: Runtime?
  private var config: URL?

  var candidates: [Candidate] { experiment?.candidates ?? [] }
  var failures: [Experiment.Failure] { experiment?.errors ?? [] }
  var canGenerate: Bool { photo != nil && strokes.contains { $0.mode == "remove" } && !busy }

  func choosePhoto() {
    let panel = NSOpenPanel()
    panel.title = "Open a RAW photo"
    panel.message = "Research uses the unedited RAW. Existing Maple edits are not loaded."
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    if panel.runModal() == .OK, let url = panel.url { open(url) }
  }

  func chooseSession() {
    let panel = NSOpenPanel()
    panel.title = "Open a research session"
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Documents/Maple Research/Mac Sessions")
    if panel.runModal() == .OK, let url = panel.url { reopen(url) }
  }

  func reopen(_ folder: URL) {
    guard !busy else { return }
    revision += 1
    let token = revision
    busy = true
    task = Task {
      do {
        struct Request: Decodable {
          let source: String
          let strokes: [Stroke]
          let prompt: String
        }
        struct Review: Decodable { let preferredModel: String }
        let request = try await disk.load(
          Request.self, from: folder.appendingPathComponent("request.json"))
        let source = URL(fileURLWithPath: request.source)
        let loaded = try await disk.load(Photo.self, from: source)
        let result = try? await disk.load(
          Experiment.self, from: folder.appendingPathComponent("result.json"))
        let review = try? await disk.load(
          Review.self, from: folder.appendingPathComponent("review.json"))
        guard token == revision else { return }
        photo = loaded
        sourceFolder = source.deletingLastPathComponent()
        jobFolder = folder
        strokes = request.strokes
        redo = []
        prompt = request.prompt
        experiment = result
        preferredModel = review?.preferredModel
        selectedModel = result?.candidates.first?.id ?? "lama"
        showResults = !(result?.candidates.isEmpty ?? true)
        actualSize = false
        busy = false
        message = "Research session reopened. You can review results or refine the selection."
      } catch { fail(error, token: token) }
    }
  }

  func open(_ url: URL) {
    cancel()
    revision += 1
    let token = revision
    busy = true
    photo = nil
    experiment = nil
    sourceFolder = nil
    jobFolder = nil
    strokes = []
    redo = []
    brush = "remove"
    showResults = false
    preferredModel = nil
    message = "Opening RAW photo…"
    task = Task {
      do {
        let (runtime, config) = try await setup()
        guard token == revision else { return }
        let folder = try await disk.create(root: runtime.sessions, request: ["raw": url.path])
        guard token == revision else { return }
        sourceFolder = folder
        let poller = poll(folder, token: token)
        defer { poller.cancel() }
        try await disk.run(command: "open", folder: folder, runtime: runtime, config: config)
        let loaded = try await disk.load(
          Photo.self, from: folder.appendingPathComponent("source.json"))
        guard token == revision else { return }
        photo = loaded
        busy = false
        message = "Paint the object in red. Protect nearby subjects in green."
      } catch { fail(error, token: token) }
    }
  }

  func generate() {
    guard canGenerate, let sourceFolder else { return }
    revision += 1
    let token = revision
    busy = true
    experiment = nil
    preferredModel = nil
    showResults = false
    actualSize = false
    original = false
    message = "Preparing the selection…"
    let snapshot = strokes
    let text = prompt
    task = Task {
      do {
        let (runtime, config) = try await setup()
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot))
        let folder = try await disk.create(
          root: runtime.sessions,
          request: [
            "source": sourceFolder.appendingPathComponent("source.json").path, "strokes": encoded,
            "prompt": text,
          ])
        guard token == revision else { return }
        jobFolder = folder
        let poller = poll(folder, token: token, results: true)
        defer { poller.cancel() }
        try await disk.run(command: "generate", folder: folder, runtime: runtime, config: config)
        let result = try await disk.load(
          Experiment.self, from: folder.appendingPathComponent("result.json"))
        guard token == revision else { return }
        experiment = result
        showResults = !result.candidates.isEmpty
        selectedModel = result.candidates.first?.id ?? "lama"
        busy = false
        message =
          result.errors.isEmpty
          ? "Compare both candidates. Mark the one you prefer."
          : (result.candidates.isEmpty
            ? "Neither candidate finished. Check the model details below, then retry."
            : "One candidate failed. The completed result is still available below.")
      } catch { fail(error, token: token) }
    }
  }

  func addStroke(_ stroke: Stroke) {
    guard !busy, !showResults else { return }
    strokes.append(stroke)
    redo = []
  }

  func undo() {
    if let last = strokes.popLast() { redo.append(last) }
  }

  func redoStroke() {
    if let last = redo.popLast() { strokes.append(last) }
  }

  func cancel() {
    revision += 1
    task?.cancel()
    task = nil
    ResearchProcess.shared.cancel()
    busy = false
    message = "Cancelled. Any completed candidate remains available."
  }

  func prefer(_ candidate: Candidate) {
    guard let jobFolder else { return }
    let token = revision
    Task {
      do {
        try await disk.preference(candidate.id, folder: jobFolder)
        guard token == revision else { return }
        preferredModel = candidate.id
        message = "\(candidate.label) marked preferred in this research session."
      } catch { fail(error, token: token) }
    }
  }

  func reveal() {
    if let folder = jobFolder ?? sourceFolder {
      NSWorkspace.shared.activateFileViewerSelecting([folder])
    }
  }

  func imagePath(_ candidate: Candidate, before: Bool = false) -> String {
    let ev = exposure >= 0 ? "+\(exposure)" : "\(exposure)"
    let wb = whiteBalance >= 0 ? "+\(whiteBalance)" : "\(whiteBalance)"
    return candidate.folder + "/\(profile)_ev\(ev)_wb\(wb)-\(before ? "truth" : "removal").png"
  }

  private func setup() async throws -> (Runtime, URL) {
    if let runtime, let config { return (runtime, config) }
    guard let config = Bundle.main.url(forResource: "runtime", withExtension: "json") else {
      throw NSError(
        domain: "RemovalLab", code: 1,
        userInfo: [
          NSLocalizedDescriptionKey:
            "Missing local runtime configuration. Rebuild this research app."
        ])
    }
    let loaded = try await disk.load(Runtime.self, from: config)
    runtime = loaded
    self.config = config
    return (loaded, config)
  }

  private func poll(_ folder: URL, token: Int, results: Bool = false) -> Task<Void, Never> {
    Task {
      while !Task.isCancelled, token == revision {
        if let status = try? await disk.load(
          WorkerStatus.self, from: folder.appendingPathComponent("status.json")), token == revision
        {
          message = status.message
        }
        if results,
          let loaded = try? await disk.load(
            Experiment.self, from: folder.appendingPathComponent("result.json")), token == revision
        {
          experiment = loaded
        }
        try? await Task.sleep(for: .milliseconds(400))
      }
    }
  }

  private func fail(_ error: Error, token: Int) {
    guard token == revision else { return }
    busy = false
    message = error.localizedDescription
  }
}
