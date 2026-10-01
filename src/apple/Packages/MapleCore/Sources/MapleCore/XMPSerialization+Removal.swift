import Foundation

extension XMPSerializer {
  static func _removalAttrs(_ model: AdjustmentModel) -> [(String, String)] {
    model.inpaintRemovals.map { [("papp:InpaintRemovals", escapeXMLAttr($0.json))] } ?? []
  }
}
