import Foundation

/// Transient eyedropper state. Owns no adjustment values; a successful sample
/// updates the edit session once, with its complete provenance and undo entry.
@MainActor
@Observable
public final class WhiteBalancePicker {
  public private(set) var isArmed = false
  public private(set) var isSampling = false
  public private(set) var message: String?
  private let session: EditSession
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored var provider:
    @Sendable (AssetRef, AdjustmentModel, CGPoint) async throws -> WhiteBalanceSample = {
      try await WhiteBalanceSampler.sample(asset: $0, model: $1, point: $2)
    }

  public init(session: EditSession) { self.session = session }

  public func arm() {
    cancel()
    guard session.asset.isRaw else {
      message = WhiteBalanceSampleError.unsupportedAsset.localizedDescription
      return
    }
    isArmed = true
  }

  public func cancel() {
    generation &+= 1
    isArmed = false
    isSampling = false
    message = nil
  }

  public func pick(at point: CGPoint?) async {
    guard isArmed, !isSampling else { return }
    guard let point else {
      message = WhiteBalanceSampleError.outsideImage.localizedDescription
      return
    }
    let request = generation
    let before = session.model
    let transactionID = session.transactions.nextID
    isSampling = true
    message = nil
    defer { if request == generation { isSampling = false } }
    let renderGeneration = await session.renderActor.currentGeneration()
    guard request == generation, !Task.isCancelled, session.model == before else { return }
    do {
      let result = try await provider(session.asset, before, point)
      let currentRenderGeneration = await session.renderActor.currentGeneration()
      guard request == generation, !Task.isCancelled else { return }
      guard session.model == before, session.transactions.nextID == transactionID,
        currentRenderGeneration == renderGeneration
      else {
        message = "The photo changed while sampling. Pick the neutral area again."
        return
      }
      guard result.temperature.isFinite, result.tint.isFinite,
        AdjustmentModel.temperatureRange.contains(result.temperature),
        AdjustmentModel.tintRange.contains(result.tint), result.algorithmVersion > 0
      else { throw WhiteBalanceSampleError.outOfDomain }
      var sampled = before
      sampled.temperature = result.temperature
      sampled.tint = result.tint
      sampled.wbScaleVersion = AdjustmentModel.default.wbScaleVersion
      sampled.wbSource = .sampled
      sampled.wbSampleX = point.x
      sampled.wbSampleY = point.y
      sampled.wbAlgorithmVersion = Double(result.algorithmVersion)
      guard sampled != before else {
        isArmed = false
        return
      }
      session.beginEdit(description: "Sample white balance")
      session.model = sampled
      session.endEdit()
      isArmed = false
    } catch {
      guard request == generation, !Task.isCancelled else { return }
      message = (error as? WhiteBalanceSampleError ?? .failed).localizedDescription
    }
  }

  public func resetToAsShot() {
    guard let temperature = session.asShotCCT, let tint = session.asShotTint else { return }
    cancel()
    var model = session.model
    model.temperature = temperature
    model.tint = tint
    model.wbScaleVersion = AdjustmentModel.default.wbScaleVersion
    model.wbSource = .asShot
    model.wbSampleX = 0
    model.wbSampleY = 0
    model.wbAlgorithmVersion = 0
    guard model != session.model else { return }
    session.beginEdit(description: "As Shot white balance")
    session.model = model
    session.endEdit()
  }

  public var provenance: String {
    let model = session.model
    switch model.wbSource {
    case .asShot: return "White balance: As Shot"
    case .manual: return "White balance: Manual"
    case .preset: return "White balance: Preset"
    case .auto:
      return model.wbAlgorithmVersion > 0
        ? "White balance: Auto · version \(model.wbAlgorithmVersion.formatted(.number.precision(.fractionLength(0))))"
        : "White balance: Auto"
    case .sampled:
      guard model.wbAlgorithmVersion > 0 else { return "White balance: Copied sample" }
      return String(
        format: "White balance: Sampled · (%.3f, %.3f) · version %.0f",
        model.wbSampleX, model.wbSampleY, model.wbAlgorithmVersion)
    }
  }
}
