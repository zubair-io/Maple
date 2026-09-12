// LensProfileChoice.swift — the Apple Lens Corrections panel's profile
// dropdown (#3567, slice 3 of the bundled-Lensfun epic #3564).
//
// raw-core (#3565) and the develop path (#3566) already ship the bundled
// Lensfun database, automatic matching, and two raw-ffi entry points this
// file is the sole Apple consumer of:
//
//   int32_t maple_lens_profile_resolve_file(const char *path,
//                                           const char *reference,
//                                           char **out_json);
//   int32_t maple_lens_profile_compatible(const char *path, char **out_json);
//   void    maple_free_lens_profile_json(char *json);
//
// `resolve_file` takes the RAW's own on-disk path plus a `papp:LensProfile`
// reference string ("" asks for the automatic match) and returns the
// resolver's evidence JSON for that exact reference — the SAME evidence the
// develop path itself resolves from, so what the panel shows is guaranteed
// to be what the next render applies. `compatible` returns every bundled
// lens the RAW's camera body can carry, for the dropdown's option list.
//
// `LensProfileChoice` is the section's view model: an `@Observable` object
// the view holds via `@State`/`@Bindable`, with the async FFI round trip
// (file read + potential cold decode on a large stack) run behind the
// `LensProfileResolver` actor so it can never block the main thread or race
// the UI (docs/best-practices.md § "Actor-isolated I/O"), and a generation
// counter so a slow load from an abandoned asset can never land on a newer
// one (docs/best-practices.md § "Generation counters for async state").
//
// The evidence-to-state mapping (`LensProfileChoice.build`) is a pure
// function of already-decoded JSON — no FFI, no file I/O, no `EditSession`
// — so it and the JSON decoding are unit-testable with literal strings and
// need no RAW fixture (MapleCoreTests/LensProfileChoiceTests.swift, listed
// in .github/swift-regressions/run.txt, not excluded.txt).

import Foundation
import os.log
import RawPipeline

private let lensProfileChoiceLog = Logger(subsystem: "app.justmaple.aperture", category: "LensProfileChoice")

/// `Result`'s `Failure` must conform to `Error`, so the FFI wrappers below
/// carry raw-ffi's error text through this instead of a bare `String`.
struct LensProfileFFIError: Error, CustomStringConvertible {
  let message: String
  var description: String { message }
}

// MARK: - RawCoreBridge FFI wrappers

extension RawCoreBridge {
  /// Wraps `maple_lens_profile_resolve_file`. `reference` `""` asks for the
  /// automatic match; any other value is a `papp:LensProfile` string
  /// (`lensfun1:…`, `lcp1:…`, `lcp1-ack:…`). Runs synchronously — callers
  /// off the main thread only (`LensProfileResolver`).
  static func lensProfileEvidenceJSON(path: String, reference: String) -> Result<String, LensProfileFFIError> {
    var out: UnsafeMutablePointer<CChar>?
    let code = path.withCString { pathPtr in
      reference.withCString { referencePtr in
        maple_lens_profile_resolve_file(pathPtr, referencePtr, &out)
      }
    }
    defer { if let out { maple_free_lens_profile_json(out) } }
    guard code == 0, let out else {
      let message = maple_last_error().map { String(cString: $0) } ?? "Couldn't resolve the lens profile"
      return .failure(LensProfileFFIError(message: message))
    }
    return .success(String(cString: out))
  }

  /// Wraps `maple_lens_profile_compatible`. Synchronous — same threading
  /// contract as `lensProfileEvidenceJSON`.
  static func lensProfileCompatibleJSON(path: String) -> Result<String, LensProfileFFIError> {
    var out: UnsafeMutablePointer<CChar>?
    let code = path.withCString { pathPtr in
      maple_lens_profile_compatible(pathPtr, &out)
    }
    defer { if let out { maple_free_lens_profile_json(out) } }
    guard code == 0, let out else {
      let message = maple_last_error().map { String(cString: $0) } ?? "Couldn't list compatible lenses"
      return .failure(LensProfileFFIError(message: message))
    }
    return .success(String(cString: out))
  }
}

/// Runs the two blocking raw-ffi calls off the main actor. A cold call
/// reads/decodes the RAW on a large stack (raw-ffi's own `with_large_stack`);
/// a warm call reuses the decode cache. Stateless — a plain actor is enough
/// to move the work off `@MainActor`, the same reason `PresetStore` is an
/// actor for its own disk I/O. `public` only so it can appear as the type of
/// `LensProfileChoice.init`'s defaulted `resolver:` parameter — nothing
/// outside MapleCore constructs or calls one directly.
public actor LensProfileResolver {
  public init() {}

  func evidence(path: String, reference: String) -> Result<String, LensProfileFFIError> {
    RawCoreBridge.lensProfileEvidenceJSON(path: path, reference: reference)
  }

  func compatible(path: String) -> Result<String, LensProfileFFIError> {
    RawCoreBridge.lensProfileCompatibleJSON(path: path)
  }
}

// MARK: - Pure evidence model

extension LensProfileChoice {
  /// Decoded `maple_lens_profile_resolve_file` evidence. `lens`/`dbVersion`
  /// are absent (not merely empty) on the JSON's `"embedded"`/`"none"`
  /// branch, hence `Optional`.
  struct Evidence: Decodable, Equatable {
    let source: String  // "lensfun" | "lcp" | "embedded" | "none"
    let lens: String?
    let dbVersion: String?
    let confidence: String?
    let hasDistortion: Bool
    let hasCa: Bool
    let hasVignetting: Bool
    let approximations: [String]
    let unsupported: [String]

    static let unavailable = Evidence(
      source: "none", lens: nil, dbVersion: nil, confidence: nil,
      hasDistortion: false, hasCa: false, hasVignetting: false,
      approximations: [], unsupported: [])

    static func decode(_ json: String) throws -> Evidence {
      try JSONDecoder().decode(Evidence.self, from: Data(json.utf8))
    }
  }

  /// One entry of `maple_lens_profile_compatible`'s `[{"slug","maker","model"}]`.
  struct CompatibleLens: Decodable, Equatable {
    let slug: String
    let maker: String
    let model: String

    static func decodeList(_ json: String) throws -> [CompatibleLens] {
      try JSONDecoder().decode([CompatibleLens].self, from: Data(json.utf8))
    }
  }
}

// MARK: - View model

/// The Lens Corrections panel's profile dropdown (#3567). Owns the current
/// `papp:LensProfile` choice for the session's asset: what the resolver
/// matched or was told to use, the full list of selectable options, which
/// correction families the resolved calibration covers, and the source
/// line's text. `select(_:)` is the dropdown's `onChange` — it writes
/// `model.lensProfile` as one undoable edit, exactly the pattern the
/// existing master toggle (`LensCorrectionsSection.enabledBinding`) already
/// uses: `session.beginEdit(...)` then a direct model mutation, closed at
/// the next transaction boundary.
@MainActor
@Observable
public final class LensProfileChoice {
  public enum Selection: Equatable, Sendable {
    /// No explicit `papp:LensProfile` — `matched` is the automatic match's
    /// display name, or `nil` when nothing in the bundle fits this body/lens.
    case automatic(matched: String?)
    /// A manual `lensfun1:<slug>` pick.
    case bundled(slug: String, name: String)
    /// An `lcp1:`/`lcp1-ack:` reference the sidecar already names (#3395).
    case imported(reference: String)
  }

  public struct Option: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    /// What `select(_:)` writes into `model.lensProfile`. `""` is Automatic.
    /// Public so the view can build a `MuiSelectOption` list directly from
    /// `options` without re-deriving the write-back value.
    public let modelValue: String

    var isAutomatic: Bool { modelValue.isEmpty }
  }

  public struct Coverage: Equatable, Sendable {
    public let hasDistortion: Bool
    public let hasCa: Bool
    public let hasVignetting: Bool

    public static let none = Coverage(hasDistortion: false, hasCa: false, hasVignetting: false)

    var hasAny: Bool { hasDistortion || hasCa || hasVignetting }
  }

  public private(set) var isLoading = true
  public private(set) var selection: Selection = .automatic(matched: nil)
  public private(set) var options: [Option] = [Option(id: "automatic", label: "Automatic", modelValue: "")]
  public private(set) var coverage: Coverage = .none
  public private(set) var sourceDescription: String = ""
  public private(set) var loadError: String?

  /// True once there is something the master toggle can turn on: either the
  /// current selection resolves to a real coverage, or the dropdown has a
  /// pickable lens (bundled or imported) beyond Automatic. Broader than the
  /// old embedded-only `EditSession.hasLensCorrections` signal, which
  /// under-reports a body Lensfun matches but that carries no `OpcodeList3`.
  public var isAvailable: Bool {
    coverage.hasAny || options.contains { !$0.isAutomatic }
  }

  /// Strong on purpose: the view recreates `LensProfileChoice` itself in
  /// `.task(id: session.asset.id)` whenever the session changes, so this
  /// object's own lifetime already tracks the session's — there is no cycle
  /// to break (`EditSession` never holds a reference back to this class).
  private let session: EditSession
  private let resolver: LensProfileResolver
  private var generation = 0

  public init(session: EditSession, resolver: LensProfileResolver = LensProfileResolver()) {
    self.session = session
    self.resolver = resolver
  }

  /// Reloads evidence + the compatible-lens list for the session's current
  /// asset and `model.lensProfile`. Call from the section's `.task(id:)`,
  /// keyed on the asset identity and the reference string, so a photo
  /// switch or an undo/redo that changes `lensProfile` re-resolves.
  public func reload() async {
    generation &+= 1
    let gen = generation

    guard let path = session.asset.primaryURL?.path else {
      // Bytes-backed assets (cloud, PhotoKit-in-memory) have no on-disk
      // path for raw-ffi to open. There is nothing to resolve; the panel
      // falls back to Automatic with no match rather than pretending a
      // correction is available.
      isLoading = false
      selection = .automatic(matched: nil)
      options = [Option(id: "automatic", label: "Automatic — no match", modelValue: "")]
      coverage = .none
      sourceDescription = "No lens correction data"
      loadError = nil
      return
    }

    let reference = session.model.lensProfile
    isLoading = true

    let compatibleResult = await resolver.compatible(path: path)
    guard gen == generation else { return }
    let compatible: [LensProfileChoice.CompatibleLens]
    switch compatibleResult {
    case .success(let json):
      compatible = (try? CompatibleLens.decodeList(json)) ?? []
    case .failure(let error):
      lensProfileChoiceLog.error("compatible-lens lookup failed: \(error.message, privacy: .public)")
      compatible = []
    }

    let autoResult = await resolver.evidence(path: path, reference: "")
    guard gen == generation else { return }
    let autoEvidence: Evidence
    switch autoResult {
    case .success(let json):
      autoEvidence = (try? Evidence.decode(json)) ?? .unavailable
    case .failure(let error):
      lensProfileChoiceLog.error("automatic-match evidence lookup failed: \(error.message, privacy: .public)")
      autoEvidence = .unavailable
    }

    var currentEvidence = autoEvidence
    var currentError: String?
    if !reference.isEmpty {
      let currentResult = await resolver.evidence(path: path, reference: reference)
      guard gen == generation else { return }
      switch currentResult {
      case .success(let json):
        currentEvidence = (try? Evidence.decode(json)) ?? .unavailable
      case .failure(let error):
        lensProfileChoiceLog.error("selected-profile evidence lookup failed: \(error.message, privacy: .public)")
        currentEvidence = .unavailable
        currentError = error.message
      }
    }

    let built = Self.build(
      reference: reference, autoEvidence: autoEvidence, currentEvidence: currentEvidence,
      compatible: compatible)

    isLoading = false
    selection = built.selection
    options = built.options
    coverage = built.coverage
    loadError = currentError
    sourceDescription = currentError ?? built.sourceDescription
  }

  /// Writes `option.modelValue` into `model.lensProfile` as one undoable
  /// edit. Mirrors `LensCorrectionsSection.enabledBinding`'s pattern for the
  /// master toggle exactly: `beginEdit` opens the transaction, the direct
  /// model mutation is what the diff/undo ring records, and the boundary
  /// closes at the next `beginEdit`/`undo`/`redo`/`endEdit` — there is
  /// nothing else for this one-shot picker action to do. The master
  /// toggle (`lensProfileEnable`) is never touched here.
  public func select(_ option: Option) {
    session.beginEdit(kind: .adjustment, description: "Lens Profile")
    session.model.lensProfile = option.modelValue
  }

  // MARK: - Pure mapping (unit-tested without FFI or a fixture)

  struct Built: Equatable {
    let selection: Selection
    let options: [Option]
    let coverage: Coverage
    let sourceDescription: String
  }

  /// Builds the dropdown state from already-decoded evidence. Pure: no FFI,
  /// no I/O, no `EditSession` — every branch is driven only by its
  /// arguments, so it's exercised directly by `LensProfileChoiceTests`.
  static func build(
    reference: String, autoEvidence: Evidence, currentEvidence: Evidence,
    compatible: [CompatibleLens]
  ) -> Built {
    let automaticLabel = autoEvidence.source == "lensfun" ? (autoEvidence.lens ?? "no match") : "no match"
    let automaticOption = Option(id: "automatic", label: "Automatic — \(automaticLabel)", modelValue: "")

    let bundledOptions = compatible
      .sorted { ($0.maker, $0.model) < ($1.maker, $1.model) }
      .map { lens -> Option in
        let value = "lensfun1:\(lens.slug)"
        return Option(id: value, label: "\(lens.maker) \(lens.model)", modelValue: value)
      }

    var options = [automaticOption] + bundledOptions

    let selection: Selection
    if reference.isEmpty {
      selection = .automatic(matched: autoEvidence.source == "lensfun" ? autoEvidence.lens : nil)
    } else if let slug = reference.hasPrefix("lensfun1:") ? String(reference.dropFirst("lensfun1:".count)) : nil {
      let name = currentEvidence.lens ?? slug
      selection = .bundled(slug: slug, name: name)
      // The selected slug is normally already one of `compatible` (it names
      // a lens this body can carry); append it defensively if a stale
      // sidecar names one the current camera match no longer lists, so the
      // dropdown still shows what's actually selected instead of silently
      // falling back to Automatic.
      if !options.contains(where: { $0.modelValue == reference }) {
        options.append(Option(id: reference, label: name, modelValue: reference))
      }
    } else {
      selection = .imported(reference: reference)
      options.append(Option(id: reference, label: "Imported profile", modelValue: reference))
    }

    let coverage = Coverage(
      hasDistortion: currentEvidence.hasDistortion, hasCa: currentEvidence.hasCa,
      hasVignetting: currentEvidence.hasVignetting)

    let sourceDescription: String
    switch currentEvidence.source {
    case "lensfun":
      sourceDescription = "Lensfun database \(currentEvidence.dbVersion ?? "") · CC BY-SA 3.0"
    case "lcp":
      sourceDescription = "Imported profile"
    case "embedded":
      sourceDescription = "Embedded corrections"
    default:
      sourceDescription = "No lens correction data"
    }

    return Built(selection: selection, options: options, coverage: coverage, sourceDescription: sourceDescription)
  }
}
