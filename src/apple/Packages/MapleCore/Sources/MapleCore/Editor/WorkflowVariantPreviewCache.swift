import CoreImage
import Foundation

/// Two viewport previews complement local disk caching for Photos/API sources.
/// Admission happens only at a settled switch, never inside the slider loop (#4063).
@MainActor
final class WorkflowVariantPreviewCache {
  private struct Entry {
    let id: String
    let xml: String
    let model: AdjustmentModel
    let width: Int
    let image: CIImage
  }
  private var entries: [Entry] = []
  var captureXML: String?

  func store(_ image: CIImage, id: String, xml: String, model: AdjustmentModel, width: Int) {
    guard width >= 1, image.extent.width > 0, image.extent.height > 0,
      max(image.extent.width, image.extent.height) <= 4096
    else { return }
    entries.removeAll { $0.id == id }
    entries.append(Entry(id: id, xml: xml, model: model, width: width, image: image))
    if entries.count > 2 { entries.removeFirst(entries.count - 2) }
  }
  func preview(id: String, xml: String?, model: AdjustmentModel, width: Int) -> CIImage? {
    entries.last { $0.id == id && $0.xml == xml && $0.model == model && $0.width == width }?.image
  }
  func clear() {
    entries.removeAll()
    captureXML = nil
  }
}
