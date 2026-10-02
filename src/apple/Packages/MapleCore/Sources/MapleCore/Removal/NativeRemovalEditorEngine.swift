import Foundation

struct RemovalStroke: Codable, Sendable {
  let points: [[Double]]
  let radius: Double
  let subtract: Bool
}

struct NativeRemovalEditorContext: Sendable {
  let id = UUID()
  let raw: URL
  let handle: MapleRawHandle
  let saved: NativeSavedRemovalSession
  let sourceBytes: Data
  let assets: [String: Data]
  let source: String
  let width: UInt32
  let height: UInt32
  let model: AdjustmentModel
  let xmp: String
}

struct RemovalPointMapping: Decodable, Sendable {
  let points: [[Double]?]
}

/// All cold RAW/model work lives off main. Contexts are immutable and owned by
/// one editor revision; proposed previews never replace the live RAW decode.
actor NativeRemovalEditorEngine {
  private var directory: URL?
  private var accessingDirectory = false
  private var reconstructor: NativeRemovalReconstructor?
  private var selector: NativeRemovalSelector?
  private var detector: NativeRemovalPersonDetector?
  private var tensors: (UUID, NativeRemovalProxyTensors)?
  private var embedding: (UUID, NativeRemovalEmbedding)?

  deinit {
    if accessingDirectory { directory?.stopAccessingSecurityScopedResource() }
  }

  func setModelDirectory(_ url: URL) throws {
    guard url.isFileURL else { throw RemovalError.invalid("Choose a local model folder") }
    if accessingDirectory { directory?.stopAccessingSecurityScopedResource() }
    directory = url
    accessingDirectory = url.startAccessingSecurityScopedResource()
    reconstructor = nil
    selector = nil
    detector = nil
    embedding = nil
  }

  private func modelPaths() throws -> (URL, URL?) {
    guard let directory else { throw RemovalError.invalid("Choose a local AI model folder first") }
    #if os(macOS)
      let bundled = directory.appendingPathComponent("runtime.dylib")
      let runtime =
        FileManager.default.fileExists(atPath: bundled.path)
        ? bundled : PanoProvisioning().resolvedOrtDylibPath()
      return (directory, runtime)
    #else
      return (directory, nil)  // The same ORT library is statically linked on iOS.
    #endif
  }

  func authoringJob() throws -> NativeRemovalAuthoringJob {
    let (directory, runtime) = try modelPaths()
    if reconstructor == nil {
      reconstructor = try NativeRemovalReconstructor.open(directory: directory, runtime: runtime)
    }
    return try NativeRemovalAuthoringJob(model: reconstructor!)
  }

  func prepare(raw: URL, model: AdjustmentModel) async throws -> NativeRemovalEditorContext {
    try Task.checkCancellation()
    let sourceBytes = try Data(contentsOf: raw)
    let handle = try PipelineRenderer.openRawHandle(rawPath: raw)
    let source = try RemovalBridge.calibrationSource(handle: handle)
    struct Source: Decodable {
      let width: UInt32
      let height: UInt32
    }
    let size = try JSONDecoder().decode(Source.self, from: Data(source.utf8))
    let records = model.inpaintRemovals?.json ?? "[]"
    let assets = try await LocalRemovalAssetStore(rawURL: raw).readAssets(records: records)
    let xmp = XMPSerializer.serialize(model: model, culling: CullingState())
    let saved = NativeSavedRemovalSession(handle: handle)
    _ = try await saved.prepare(
      source: sourceBytes, ext: raw.pathExtension, xmp: xmp, assets: assets)
    try Task.checkCancellation()
    return NativeRemovalEditorContext(
      raw: raw, handle: handle, saved: saved, sourceBytes: sourceBytes, assets: assets,
      source: source,
      width: size.width, height: size.height, model: model, xmp: xmp)
  }

  func map(
    _ points: [[Double]], context: NativeRemovalEditorContext, cropInputSize: [UInt32]
  ) throws -> [[Double]?] {
    let request: [String: Any] = [
      "schema": 1, "crop_input_size": cropInputSize, "points": points,
    ]
    let mapped = try RemovalBridge.mapDisplayPoints(
      handle: context.handle, xmp: context.xmp, request: json(request))
    return try JSONDecoder().decode(RemovalPointMapping.self, from: Data(mapped.utf8)).points
  }

  func paint(_ strokes: [RemovalStroke], context: NativeRemovalEditorContext) throws -> Data {
    guard !strokes.isEmpty else { return Data() }
    struct Request: Encodable {
      let schema = 1
      let strokes: [RemovalStroke]
    }
    let request = String(
      decoding: try JSONEncoder().encode(Request(strokes: strokes)), as: UTF8.self)
    return try RemovalBridge.selection(
      width: context.width, height: context.height, request: request)
  }

  func smart(
    _ strokes: [RemovalStroke], context: NativeRemovalEditorContext,
    operation: NativeRemovalInferenceOperation
  ) async throws -> Data {
    guard !strokes.isEmpty else { return Data() }
    let inputs = try await selectionInputs(context)
    let request = try RemovalBridge.smartStrokes(
      request: smartRequest(context, inputs: inputs, strokes: strokes))
    return try refine(request, context: context, inputs: inputs, operation: operation)
  }

  func selectionOperation() throws -> NativeRemovalInferenceOperation {
    try selectionModel().operation()
  }

  private func selectionModel() throws -> NativeRemovalSelector {
    let (directory, runtime) = try modelPaths()
    if selector == nil {
      selector = try NativeRemovalSelector.open(directory: directory, runtime: runtime)
    }
    return selector!
  }

  func detectionOperation() throws -> NativeRemovalInferenceOperation {
    let (directory, runtime) = try modelPaths()
    if detector == nil {
      detector = try NativeRemovalPersonDetector.open(directory: directory, runtime: runtime)
    }
    return try detector!.operation()
  }

  func detect(
    context: NativeRemovalEditorContext, operation: NativeRemovalInferenceOperation
  ) async throws -> [NativeRemovalDetection] {
    let inputs = try await selectionInputs(context)
    guard let detector else { throw RemovalError.invalid("Person detection is not prepared") }
    try Task.checkCancellation()
    return try detector.detect(
      rgb: inputs.detector, sourceWidth: context.width, sourceHeight: context.height,
      operation: operation)
  }

  func personMask(
    _ detection: NativeRemovalDetection, context: NativeRemovalEditorContext,
    operation: NativeRemovalInferenceOperation
  ) async throws -> Data {
    let inputs = try await selectionInputs(context)
    let box = detection.bounds
    let clamp = { (value: Double) in min(1, max(0, value)) }
    let first = [
      clamp(Double(box[0]) / Double(context.width)), clamp(Double(box[1]) / Double(context.height)),
    ]
    let last = [
      clamp(Double(box[2]) / Double(context.width)), clamp(Double(box[3]) / Double(context.height)),
    ]
    guard first[0] < last[0], first[1] < last[1] else { return Data() }
    let prompts: [[String: Any]] = [
      ["position": first, "label": 2], ["position": last, "label": 3],
    ]
    let request = try smartRequest(context, inputs: inputs, strokes: [], prompts: prompts)
    return try refine(request, context: context, inputs: inputs, operation: operation)
  }

  private func refine(
    _ request: String, context: NativeRemovalEditorContext, inputs: NativeRemovalProxyTensors,
    operation: NativeRemovalInferenceOperation
  ) throws -> Data {
    try Task.checkCancellation()
    let model = try selectionModel()
    if embedding?.0 != context.id {
      embedding = (
        context.id,
        try model.encode(
          source: context.source, request: request, rgb: inputs.encoder, operation: operation)
      )
    }
    return try model.refine(
      source: context.source, request: request, embedding: embedding!.1, operation: operation)
  }

  private func selectionInputs(_ context: NativeRemovalEditorContext) async throws
    -> NativeRemovalProxyTensors
  {
    if let tensors, tensors.0 == context.id { return tensors.1 }
    let proxy = try await context.saved.selectionProxy(xmp: context.xmp)
    try Task.checkCancellation()
    let inputs = try NativeRemovalProxyTensors(proxy, width: context.width, height: context.height)
    tensors = (context.id, inputs)
    return inputs
  }

  private func smartRequest(
    _ context: NativeRemovalEditorContext, inputs: NativeRemovalProxyTensors,
    strokes: [RemovalStroke], prompts: [[String: Any]] = []
  ) throws -> String {
    let encodedStrokes = try JSONSerialization.jsonObject(with: JSONEncoder().encode(strokes))
    return try json([
      "schema": 1, "source_width": context.width, "source_height": context.height,
      "window": ["x": 0, "y": 0, "width": context.width, "height": context.height],
      "input_width": inputs.inputWidth, "input_height": inputs.inputHeight,
      "prompts": prompts, "strokes": encodedStrokes,
    ])
  }

  /// Extend only the temporary stack so the next person sees prior generated
  /// pixels and records their context dependencies. No companions are written.
  func appending(_ proposal: NativeRemovalProposal, to context: NativeRemovalEditorContext)
    async throws -> NativeRemovalEditorContext
  {
    let prior = context.model.inpaintRemovals?.json ?? "[]"
    let records = try RemovalBridge.prepare(
      request: proposal.request, prior: prior, mask: proposal.mask, patch: proposal.patch)
    var assets = context.assets
    let names = try RemovalBridge.assetNames(records: records)
    for content in [proposal.mask, proposal.patch] {
      let digest = String(try RemovalBridge.digest(content).dropFirst(7))
      guard let name = names.first(where: { $0.hasPrefix(digest + ".") }) else {
        throw RemovalError.invalid("Review is missing a proposed companion")
      }
      assets[name] = content
    }
    var model = context.model
    model.inpaintRemovals = try RemovalRecords(json: records)
    return try await preparedContext(model: model, assets: assets, from: context)
  }

  func replacementInput(id: String, original: NativeRemovalEditorContext) async throws
    -> NativeRemovalEditorContext
  {
    let records = try RemovalBridge.savedPrefix(
      records: original.model.inpaintRemovals?.json ?? "[]", id: id)
    var model = original.model
    model.inpaintRemovals = try RemovalRecords(json: records)
    return try await preparedContext(model: model, assets: original.assets, from: original)
  }

  func replacementReview(
    id: String, original: NativeRemovalEditorContext,
    candidate: NativeRemovalEditorContext
  ) async throws -> NativeRemovalEditorContext {
    let records = try RemovalBridge.savedEdit(
      records: original.model.inpaintRemovals?.json ?? "[]", id: id, action: .replace,
      replacement: candidate.model.inpaintRemovals?.json ?? "[]")
    var model = original.model
    model.inpaintRemovals = try RemovalRecords(json: records)
    let assets = original.assets.merging(candidate.assets) { _, new in new }
    return try await preparedContext(model: model, assets: assets, from: original)
  }

  private func preparedContext(
    model: AdjustmentModel, assets: [String: Data],
    from context: NativeRemovalEditorContext
  ) async throws -> NativeRemovalEditorContext {
    let names = try RemovalBridge.assetNames(records: model.inpaintRemovals?.json ?? "[]")
    let selected = try Dictionary(
      uniqueKeysWithValues: names.map { name in
        guard let bytes = assets[name] else { throw RemovalError.missingCompanion(name) }
        return (name, bytes)
      })
    let xmp = XMPSerializer.serialize(model: model, culling: CullingState())
    let candidate = NativeSavedRemovalSession(handle: context.handle)
    _ = try await candidate.prepare(
      source: context.sourceBytes, ext: context.raw.pathExtension, xmp: xmp, assets: selected)
    try Task.checkCancellation()
    return NativeRemovalEditorContext(
      raw: context.raw, handle: context.handle, saved: candidate,
      sourceBytes: context.sourceBytes, assets: selected, source: context.source,
      width: context.width, height: context.height, model: model, xmp: xmp)
  }

  func review(_ context: NativeRemovalEditorContext) async throws -> NativeRemovalRender {
    try await context.saved.preview(xmp: context.xmp, maxLongEdge: 2048)
  }

  private func json(_ value: [String: Any]) throws -> String {
    guard JSONSerialization.isValidJSONObject(value) else {
      throw RemovalError.invalid("Removal selection contains invalid coordinates.")
    }
    return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
  }
}
