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
      case .people: return "Background people"
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
    public let role: RemovalPersonRole
    public init(
      id: Int, detection: NativeRemovalDetection, keep: Bool,
      role: RemovalPersonRole = .uncertain
    ) {
      self.id = id
      self.detection = detection
      self.keep = keep
      self.role = role
    }
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
  public internal(set) var personChoicesNeedApply = false
  public internal(set) var personProtectionConflicts: [RemovalPersonProtectionConflict] = []
  public internal(set) var savedRemovals: [SavedRemovalEntry] = []
  public internal(set) var replacingRemovalID: String?
  @ObservationIgnored var replacementBase = Data()
  @ObservationIgnored var paintedSelectionBase = Data()
  @ObservationIgnored var replacementOriginal: NativeRemovalEditorContext?
  public internal(set) var refiningPersonID: Int?
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
  @ObservationIgnored var detectedPersonMasks: [RemovalPersonSelection] = []
  @ObservationIgnored var personBases: [RemovalPersonSelection] = []
  @ObservationIgnored var personGestures: [RemovalPersonGesture] = []
  @ObservationIgnored var redoPersonGestures: [RemovalPersonGesture] = []
  @ObservationIgnored var job: NativeRemovalAuthoringJob?
  @ObservationIgnored var operation: NativeRemovalInferenceOperation?
  @ObservationIgnored private var scope: RemovalSecurityScope?
  #if os(macOS)
    @ObservationIgnored let modelStore: MacRemovalModelStore
  #endif

  public init(session: EditSession) {
    self.session = session
    #if os(macOS)
      modelStore = .shared
    #endif
  }

  #if os(macOS)
    init(session: EditSession, modelStore: MacRemovalModelStore) {
      self.session = session
      self.modelStore = modelStore
    }
  #endif

  public var busy: Bool {
    phase == .preparing || phase == .selecting || phase == .generating || phase == .saving
  }
  public var canUndoSelection: Bool {
    !busy && phase == .ready && (mode == .people ? !personGestures.isEmpty : !strokes.isEmpty)
  }
  public var canRedoSelection: Bool {
    !busy && phase == .ready
      && (mode == .people ? !redoPersonGestures.isEmpty : !redoGestures.isEmpty)
  }
  public var canPaint: Bool { mode != .people || refiningPersonID != nil }
  public func canRefinePerson(_ id: Int) -> Bool { personBases.contains { $0.id == id } }
  public var canRemove: Bool {
    guard phase == .ready, modelFolderName != nil else { return false }
    return mode == .people && personChoicesNeedApply
      ? people.contains { !$0.keep } : !selection.isEmpty
  }

  public var requiresProtectionReview: Bool {
    mode == .people && !personChoicesNeedApply && !personProtectionConflicts.isEmpty
  }

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
      #if os(macOS)
        do {
          let installed = try await modelStore.installedDirectory()
          guard current(token) else { return }
          if let installed {
            try await engine.setModelDirectory(installed)
            guard current(token) else { return }
            modelFolderName = "Installed local models"
          } else {
            modelFolderName = nil
          }
        } catch {
          guard current(token) else { return }
          modelFolderName = nil
          message = "Local models need reinstalling: \(error.localizedDescription)"
        }
      #endif
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
      savedRemovals = try RemovalBridge.savedList(
        records: captured.model.inpaintRemovals?.json ?? "[]")
      phase = .ready
      if mode == .people { await findPeople() }
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
    savedRemovals = []
    replacingRemovalID = nil
    replacementBase = Data()
    paintedSelectionBase = Data()
    replacementOriginal = nil
    personMasks = []
    detectedPersonMasks = []
    resetPersonRefinement()
    preview = nil
    compare = false
    selection = Data()
    protection = Data()
    manualProtection = Data()
    strokes = []
    gestureSizes = []
    redoGestures = []
    people = []
    personChoicesNeedApply = false
    // A fresh editor entry starts in Paint. People detection begins only
    // after the user explicitly chooses People, never as a tab-open side effect.
    mode = .paint
    message = ""
    active = false
    phase = .closed
    scope = nil
  }

  public func chooseModelFolder(_ url: URL) async {
    guard active, !busy, phase != .review else { return }
    let token = revision
    let returnPhase = phase
    phase = .preparing
    do {
      #if os(macOS)
        let installed = try await modelStore.install(from: url)
        guard current(token) else { return }
        try await engine.setModelDirectory(installed)
      #else
        try await engine.setModelDirectory(url)
      #endif
      guard current(token) else { return }
      #if os(macOS)
        modelFolderName = "Installed local models"
        message = "Local models verified. This experiment is not release-qualified."
      #else
        modelFolderName = url.lastPathComponent
        message =
          "Models are checksum-verified when used. This experiment is not release-qualified."
      #endif
      phase = returnPhase
      if mode == .people, people.isEmpty, phase == .ready { await findPeople() }
    } catch { fail(error, token: token, phase: returnPhase) }
  }

  public func setMode(_ next: Mode) async {
    guard phase == .ready, mode != next, replacingRemovalID == nil else { return }
    clearSelection()
    people = []
    detectedPersonMasks = []
    mode = next
    if next == .people { await findPeople() }
  }

  public func clearSelection() {
    guard phase == .ready else { return }
    revision &+= 1
    selection = Data()
    replacementBase = Data()
    paintedSelectionBase = Data()
    strokes = []
    personMasks = []
    personChoicesNeedApply = false
    resetPersonRefinement()
    gestureSizes = []
    redoGestures = []
  }

  /// Freeze an explicit Smart paint result for precise brush corrections
  /// (#3984). No model failure is silently converted into painted intent.
  public func refineWithPaint() {
    guard phase == .ready, mode == .smart, !selection.isEmpty,
      replacingRemovalID == nil
    else { return }
    let base = selection
    clearSelection()
    mode = .paint
    paintedSelectionBase = base
    selection = base
    message = "Refine the selection with Add or Subtract, then click Remove."
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
    people = people.map { Person(id: $0.id, detection: $0.detection, keep: false, role: $0.role) }
    clearSelection()
    if mode == .people, !people.isEmpty {
      personChoicesNeedApply = true
      message = "Protection cleared. Review the selected people before clicking Remove."
    }
  }

  public func clearSelectedPeople() {
    guard phase == .ready, mode == .people else { return }
    clearSelection()
    people = people.map { Person(id: $0.id, detection: $0.detection, keep: true, role: $0.role) }
    personChoicesNeedApply = true
    message = "No people selected for removal. Select people in the list."
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
    job?.cancel()
    operation?.cancel()
    job = nil
    operation = nil
    message = error.localizedDescription
    self.phase = phase
  }
}
