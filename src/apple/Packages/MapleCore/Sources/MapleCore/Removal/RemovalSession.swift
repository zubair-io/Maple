import Foundation

/// Editor-owned temporary selection/review state (#3984). The only accepted
/// model mutation is EditSession.acceptRemoval's durable publication boundary.
@MainActor
@Observable
public final class RemovalSession {
  public enum Mode: String, CaseIterable, Sendable {
    case paint, smart, people
    public var label: String {
      switch self {
      case .paint: return "Paint"
      case .smart: return "Smart paint"
      case .people: return "People"
      }
    }
  }
  public enum Phase: Sendable {
    case closed, preparing, ready, selecting, generating, review, saving, failed
  }
  public struct Person: Identifiable, Sendable {
    public let id: Int
    public let detection: NativeRemovalDetection
    public var keep: Bool
  }

  public let session: EditSession
  public private(set) var mode: Mode = .paint
  public internal(set) var phase: Phase = .closed
  public internal(set) var selection = Data()
  public internal(set) var protection = Data()
  public internal(set) var preview: NativeRemovalRender?
  public var compare = false
  public internal(set) var message = ""
  public internal(set) var people: [Person] = []
  public private(set) var modelFolderName: String?
  public var radius: Double = 0.02
  public var subtract = false
  public internal(set) var active = false

  @ObservationIgnored let engine = NativeRemovalEditorEngine()
  @ObservationIgnored var context: NativeRemovalEditorContext?
  @ObservationIgnored var snapshot: RemovalAuthoringSnapshot?
  @ObservationIgnored var revision: UInt64 = 0
  @ObservationIgnored var strokes: [RemovalStroke] = []
  @ObservationIgnored var gestureSizes: [Int] = []
  @ObservationIgnored var redoGestures: [[RemovalStroke]] = []
  @ObservationIgnored var manualProtection = Data()
  @ObservationIgnored var proposals: [NativeRemovalProposal] = []
  @ObservationIgnored var personMasks: [Data] = []
  @ObservationIgnored var job: NativeRemovalAuthoringJob?
  @ObservationIgnored var operation: NativeRemovalInferenceOperation?
  @ObservationIgnored private var scope: RemovalSecurityScope?

  public init(session: EditSession) { self.session = session }

  public var busy: Bool {
    phase == .preparing || phase == .selecting || phase == .generating || phase == .saving
  }
  public var canUndoSelection: Bool { !busy && phase == .ready && !strokes.isEmpty }
  public var canRedoSelection: Bool { !busy && phase == .ready && !redoGestures.isEmpty }
  public var canRemove: Bool { phase == .ready && !selection.isEmpty && modelFolderName != nil }

  public func open() async {
    guard phase != .saving else { return }
    close()
    active = true
    phase = .preparing
    let token = revision
    guard session.asset.isRaw, let raw = session.asset.primaryURL else {
      message = "Remove currently requires a RAW in a writable local photo folder."
      phase = .failed
      return
    }
    scope = RemovalSecurityScope(session.asset.scopeParentURL ?? raw.deletingLastPathComponent())
    do {
      let captured = try await session.removalAuthoringSnapshot()
      guard current(token) else { return }
      guard session.model == captured.model else { throw RemovalError.saveConflict }
      let prepared = try await engine.prepare(raw: raw, model: captured.model)
      guard current(token) else { return }
      guard session.model == captured.model, session.editRevision == captured.editRevision else {
        throw RemovalError.saveConflict
      }
      snapshot = captured
      context = prepared
      phase = .ready
    } catch { fail(error, token: token, phase: .failed) }
  }

  public func close() {
    revision &+= 1
    job?.cancel()
    operation?.cancel()
    job = nil
    operation = nil
    context = nil
    snapshot = nil
    proposals = []
    personMasks = []
    preview = nil
    compare = false
    selection = Data()
    protection = Data()
    manualProtection = Data()
    strokes = []
    gestureSizes = []
    redoGestures = []
    people = []
    message = ""
    active = false
    phase = .closed
    scope = nil
  }

  public func chooseModelFolder(_ url: URL) async {
    guard !busy, phase != .review else { return }
    let token = revision
    do {
      try await engine.setModelDirectory(url)
      guard current(token) else { return }
      modelFolderName = url.lastPathComponent
      message = "Models are checksum-verified when used. This experiment is not release-qualified."
    } catch { fail(error, token: token) }
  }

  public func setMode(_ next: Mode) {
    guard phase == .ready, mode != next else { return }
    clearSelection()
    people = []
    mode = next
  }

  public func clearSelection() {
    guard phase == .ready else { return }
    revision &+= 1
    selection = Data()
    strokes = []
    personMasks = []
    gestureSizes = []
    redoGestures = []
  }

  public func protectSelection() {
    guard phase == .ready, !selection.isEmpty else { return }
    do {
      manualProtection = try RemovalBridge.combineMasks(manualProtection, selection)
      protection = try RemovalBridge.combineMasks(protection, selection)
      clearSelection()
    } catch { message = error.localizedDescription }
  }

  public func clearProtection() {
    guard phase == .ready else { return }
    manualProtection = Data()
    protection = Data()
    people = people.map { Person(id: $0.id, detection: $0.detection, keep: false) }
    clearSelection()
  }

  public func cancel() {
    guard phase != .saving else { return }
    revision &+= 1
    job?.cancel()
    operation?.cancel()
    job = nil
    operation = nil
    proposals = []
    preview = nil
    compare = false
    message = ""
    phase = context == nil ? .closed : .ready
  }

  func current(_ token: UInt64) -> Bool { active && token == revision && !Task.isCancelled }

  func fail(_ error: Error, token: UInt64, phase: Phase = .ready) {
    guard current(token) else { return }
    message = error.localizedDescription
    self.phase = phase
  }
}
