// EditorToolPanel.swift — the control surface of every tool that has no
// single primary field (HSL has 24 sub-params, Film picks a string id, Heal
// writes a spot list…), shared by the compact bottom bar and the landscape
// vertical bar. Every other tool is edited on the drag bar.

import MapleCore
import SwiftUI

struct EditorToolPanel: View {
  @Bindable var state: EditorState

  static func replacesDragBar(_ tool: Tool) -> Bool {
    PanelKind(tool) != nil
  }

  private enum PanelKind {
    case crop, hsl, colorGrade, toneCurve, filmLook, geometry, lensCorrections, defringe, mask,
      heal

    init?(_ tool: Tool) {
      switch tool {
      case .crop: self = .crop
      case .hsl: self = .hsl
      case .colorGrade: self = .colorGrade
      case .toneCurve: self = .toneCurve
      case .filmLook: self = .filmLook
      case .geometry: self = .geometry
      case .lensCorrections: self = .lensCorrections
      case .defringe: self = .defringe
      case .mask: self = .mask
      case .heal: self = .heal
      default: return nil
      }
    }
  }

  var body: some View {
    if let kind = PanelKind(state.armedTool) {
      switch kind {
      case .crop:
        CropToolbar(state: state)
      case .hsl:
        HSLSection(state: state).editorContextInsets()
      case .colorGrade:
        ColorGradingPanel(state: state).editorContextInsets()
      case .toneCurve:
        ToneCurveSection(state: state).editorContextInsets()
      case .filmLook:
        FilmSection(state: state).editorContextInsets()
      case .geometry:
        GeometrySection(state: state).editorContextInsets()
      case .lensCorrections:
        LensCorrectionsSection(state: state).editorContextInsets()
      case .defringe:
        DefringeSection(state: state).editorContextInsets()
      case .mask:
        MaskPanel(state: state).editorContextInsets()
      case .heal:
        RetouchPanel(state: state).editorContextInsets()
      }
    }
  }
}
