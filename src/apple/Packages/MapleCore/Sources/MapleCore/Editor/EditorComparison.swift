import CoreImage
import Foundation

/// One bounded comparison image per editor. It is derived from the immutable
/// session-open model, with the live crop only to keep comparison registered.
@MainActor
@Observable
public final class EditorComparison {
  public struct Request: Equatable {
    let model: AdjustmentModel
    let target: CGSize
    let nativeSize: CGSize
    let asShot: ImageEditPipeline.AsShotWB?
  }

  private let session: EditSession
  public private(set) var image: CIImage?
  public private(set) var error: String?
  private var completed: Request?
  private var pending: Request?

  public init(session: EditSession) { self.session = session }

  public func request(viewport: CGSize) -> Request {
    var model = session.originalModel
    model.crop = session.effectiveCrop
    let target = CGSize(width: max(1, viewport.width), height: max(1, viewport.height))
    return Request(
      model: model, target: target, nativeSize: session.nativeImageSize,
      asShot: session.wbDeltaAnchor)
  }

  public func prepare(_ request: Request) async {
    if completed == request, image != nil { return }
    pending = request
    image = nil
    error = nil
    let lattice = session.filmLutStore.lattice(for: request.model.filmLook)
    do {
      let rendered = try await session.renderActor.renderComparison(
        asset: session.asset, model: request.model, target: request.target,
        nativeSize: request.nativeSize, asShot: request.asShot, filmLattice: lattice)
      guard !Task.isCancelled, pending == request else { return }
      image = rendered
      completed = request
    } catch {
      guard !Task.isCancelled, pending == request else { return }
      self.error = "Original preview unavailable"
    }
  }
}
