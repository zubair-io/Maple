// One explicit native Remove action (#3984). This produces reviewable assets;
// the editor's Keep action owns publication and the sidecar compare-and-swap.
import Foundation

/// A single cancellable generation using an already verified saved stack and
/// retained model. Work runs off main. The editor must also compare its image,
/// selection and XMP revision before presenting or accepting the proposal.
public actor NativeRemovalAuthoringJob {
  private let model: NativeRemovalReconstructor
  private nonisolated let operation: NativeRemovalInferenceOperation
  private nonisolated let contextCancellation: CancelFlag
  private var started = false

  public init(model: NativeRemovalReconstructor) throws {
    self.model = model
    operation = try model.operation()
    contextCancellation = CancelFlag()
  }

  /// Atomic flags can interrupt synchronous Rust/ORT work without waiting for
  /// this actor to finish inference. Cancelling never writes companion assets.
  public nonisolated func cancel() {
    contextCancellation.requestCancel()
    operation.cancel()
  }

  public func propose(
    handle: MapleRawHandle, saved: NativeSavedRemovalSession, xmp: String,
    intent: Data, protected: Data = Data(), holeRadius: UInt32, fringeRadius: Float
  ) async throws -> NativeRemovalProposal {
    guard !started else { throw RemovalError.invalid("Removal authoring job is already used") }
    started = true
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      let prior = try RemovalXMPRecords.read(Data(xmp.utf8)) ?? "[]"
      let source = try RemovalBridge.calibrationSource(handle: handle)
      let plan = try NativeRemovalGeneration.plan(
        source: source, intent: intent, holeRadius: holeRadius, fringeRadius: fringeRadius)
      let window = try JSONDecoder().decode(Plan.self, from: Data(plan.utf8)).window
      let scene = try await saved.generationContext(
        xmp: xmp, x: window.x, y: window.y, width: window.width, height: window.height,
        cancel: contextCancellation)
      try Task.checkCancellation()
      let request: [String: Any] = [
        "schema": 1,
        "source": try JSONSerialization.jsonObject(with: Data(source.utf8)),
        "masks": try JSONSerialization.jsonObject(with: Data(plan.utf8)),
        "model": model.modelDigest,
        "model_version": model.modelVersion,
      ]
      let generation = try NativeRemovalGeneration.prepare(
        request: String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self),
        prior: prior, scene: scene, intent: intent, protected: protected)
      try Task.checkCancellation()
      let proposal = try generation.reconstruct(
        using: model, operation: operation, cancel: contextCancellation)
      try Task.checkCancellation()
      return proposal
    } onCancel: {
      self.cancel()
    }
  }

  private struct Plan: Decodable {
    struct Window: Decodable {
      let x: UInt32
      let y: UInt32
      let width: UInt32
      let height: UInt32
    }
    let window: Window
  }
}
