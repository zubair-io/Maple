import Foundation

/// Achieved per-image Auto fit, carried by the existing render work (#4096).
public enum AutoFitStatus: Sendable, Equatable {
  case pending, active, unavailable

  public func description(profile: Profile) -> String {
    guard profile == .auto else { return "Neutral uses a fixed base rendering." }
    switch self {
    case .pending: return "Checking Auto matching for this image…"
    case .active: return "Color and contrast matched to this image’s embedded camera preview."
    case .unavailable:
      return "Auto matching is unavailable for this image; camera-preview matching was not applied."
    }
  }
}

@MainActor
extension EditSession {
  func resetAutoFitStatus() {
    autoFitRevision &+= 1
    autoFitStatus = .pending
  }

  /// A failed render can settle an unfinished fit, but cannot invalidate a completed outcome.
  func settleAutoFitFailure(assetID: UUID, profile: Profile, revision: UInt64) {
    guard autoFitStatus == .pending else { return }
    publishAutoFit(false, assetID: assetID, profile: profile, revision: revision)
  }

  func publishAutoFit(_ achieved: Bool, assetID: UUID, profile: Profile, revision: UInt64) {
    guard asset.id == assetID, model.profile == profile, profile == .auto,
      autoFitRevision == revision
    else { return }
    autoFitStatus = achieved ? .active : .unavailable
  }
}
