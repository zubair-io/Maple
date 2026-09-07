// IPhoneControlBar.swift — compact S5 controls for the iPhone idiom.
//
// The intentional vertical order is contextual controls, slider, group tabs,
// then tool buttons.
// iPad and macOS continue to use the canvas-first dock/panel controls.

import MapleCore
import SwiftUI

struct IPhoneControlBar: View {
  @Bindable var state: EditorState
  var onPresetsTap: () -> Void = {}
  var maximumPanelHeight: CGFloat = 300
  @State private var controlsHeight: CGFloat = 0

  var body: some View {
    VStack(spacing: 0) {
      // One measured content tree stays mounted during rotation. Short tools
      // keep their intrinsic height; only a tall selected tool scrolls. Group
      // tabs and tool pills stay pinned outside this bounded region.
      ScrollViewReader { proxy in
        ScrollView {
          contextualControls
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) {
              $0.size.height
            } action: {
              controlsHeight = $0
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(maximumPanelHeight, controlsHeight))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-iphone-selected-control")
        .onChange(of: controlsHeight) { _, _ in revealSelectedControl(proxy) }
        .onChange(of: maximumPanelHeight) { _, _ in revealSelectedControl(proxy) }
        .onChange(of: state.armedTool) { _, _ in revealSelectedControl(proxy) }
      }

      Divider().background(MapleTokens.border)
      GroupTabsView(state: state)
      ToolPillRow(state: state, onPresetsTap: onPresetsTap)
    }
    .frame(maxWidth: .infinity)
    .background(MapleTokens.bg)
    .safeAreaPadding(.bottom, 6)
    .animation(MapleTokens.Motion.groupSwap, value: state.armedGroup)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("editor-iphone-controls")
  }

  private var contextualControls: some View {
    VStack(spacing: 0) {
      if state.armedGroup == .color {
        ColorAccessoryRow(state: state, compactStyle: true)
          .transition(.opacity)
      }

      SubParamRow(state: state)

      selectedToolControl.id("iphone-armed-control")
    }
  }

  private func revealSelectedControl(_ proxy: ScrollViewProxy) {
    proxy.scrollTo("iphone-armed-control", anchor: .top)
  }

  @ViewBuilder
  private var selectedToolControl: some View {
    if state.armedTool == .crop {
      CropToolbar(state: state)
    } else if state.armedTool == .hsl {
      // 8-band HSL panel replaces the drag bar (#274): HSL has
      // 24 sub-params and no single primary field, so the band
      // chips + three per-band sliders are its control surface.
      HSLSection(state: state)
        .padding(.horizontal, 24)
        .padding(.vertical, 7)
    } else if state.armedTool == .colorGrade {
      ColorGradingPanel(state: state)
        .padding(.horizontal, 24)
        .padding(.vertical, 7)
    } else if state.armedTool == .toneCurve {
      // Curve plot + four region sliders replace the drag bar
      // (#367): Tone Curve has eight fields and no single primary
      // one, so the plot and the region sliders are its surface.
      ToneCurveSection(state: state)
        .padding(.horizontal, 24)
        .padding(.vertical, 7)
    } else if state.armedTool == .filmLook {
      // Category-grouped film catalog + strength slider replace
      // the drag bar (#2683): Film has no single primary field
      // (the catalog pick is a string id), so this is its whole
      // control surface, same swap as Tone Curve.
      FilmSection(state: state)
        .padding(.horizontal, 24)
        .padding(.vertical, 7)
    } else if state.armedTool == .lensCorrections {
      // Master toggle + three DNG-correction sliders replace the
      // drag bar (#2231): Lens has no single primary field, so
      // this is its whole control surface, same swap as Tone
      // Curve / Film.
      LensCorrectionsSection(state: state)
        .padding(.horizontal, 24)
        .padding(.vertical, 7)
    } else if state.armedTool == .mask {
      // Keep the selected mask's controls scrollable without allowing the
      // layer stack to cover the photograph on a short landscape screen.
      MaskPanel(state: state)
        .padding(.horizontal, 24)
        .padding(.vertical, 7)
    } else {
      DragBar(state: state)
        .padding(.vertical, 7)
    }

  }
}
