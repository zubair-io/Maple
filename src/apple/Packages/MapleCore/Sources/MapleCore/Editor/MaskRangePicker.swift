// MaskRangePicker.swift — transient state for the mask panel's colour-range
// eyedropper (#362). The twin of `WhiteBalancePicker`: owns no adjustment
// values; a successful sample re-centres the SELECTED layer's range once,
// as one undo entry, keeping the layer's band width and feather.

import Foundation

@MainActor
@Observable
public final class MaskRangePicker {
  public private(set) var isArmed = false
  public private(set) var isSampling = false
  public private(set) var message: String?
  private let session: EditSession
  @ObservationIgnored private var generation: UInt64 = 0
  @ObservationIgnored var provider:
    @Sendable (AssetRef, AdjustmentModel, CGPoint) async throws -> MaskRangeSample = {
      try await MaskRangeSampler.sample(asset: $0, model: $1, point: $2)
    }

  public init(session: EditSession) { self.session = session }

  /// Arm for the selected mask. No selection = nothing to seed, so the
  /// picker stays down rather than sampling into thin air.
  public func arm() {
    cancel()
    guard session.selectedMaskId != nil else { return }
    guard session.asset.isRaw else {
      message = MaskRangeSampleError.unsupportedAsset.localizedDescription
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
      message = MaskRangeSampleError.outsideImage.localizedDescription
      return
    }
    guard let layerId = session.selectedMaskId else {
      cancel()
      return
    }
    let request = generation
    let before = session.model
    let transactionID = session.transactions.nextID
    isSampling = true
    message = nil
    defer { if request == generation { isSampling = false } }
    do {
      let sample = try await provider(session.asset, before, point)
      guard request == generation, !Task.isCancelled else { return }
      guard session.model == before, session.transactions.nextID == transactionID else {
        message = "The photo changed while sampling. Pick the colour again."
        return
      }
      guard sample.hueDeg.isFinite, sample.chromaMin.isFinite, sample.lMin.isFinite,
        sample.lMax.isFinite
      else { throw MaskRangeSampleError.failed }
      guard let index = before.localAdjustments.firstIndex(where: { $0.id == layerId }) else {
        cancel()
        return
      }
      // A layer without a range is enabled by the pick itself — the
      // eyedropper IS the way to say "this colour", so it must not demand
      // the toggle first. Width and feather come from the layer's own
      // range when it has one, else raw-core's defaults.
      var sampled = before
      let current = sampled.localAdjustments[index].range ?? .coreDefault
      sampled.localAdjustments[index].range = current.seeded(with: sample)
      guard sampled != before else {
        isArmed = false
        return
      }
      session.beginEdit(description: "Sample colour range")
      session.model = sampled
      session.endEdit()
      isArmed = false
    } catch {
      guard request == generation, !Task.isCancelled else { return }
      message = (error as? MaskRangeSampleError ?? .failed).localizedDescription
    }
  }
}
