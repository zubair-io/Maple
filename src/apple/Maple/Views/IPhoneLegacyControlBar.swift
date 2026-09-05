// IPhoneLegacyControlBar.swift — original S5 controls, restored for iPhone.
//
// The intentional vertical order is contextual controls, slider, group tabs,
// then tool buttons.
// iPad and macOS continue to use the canvas-first dock/panel controls.

import MapleCore
import SwiftUI

struct IPhoneLegacyControlBar: View {
    @Bindable var state: EditorState
    var onPresetsTap: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            if state.armedGroup == .color {
                ColorAccessoryRow(state: state, compactStyle: true)
                    .transition(.opacity)
            }

            SubParamRow(state: state)

            if state.armedTool == .crop {
                CropToolbar(state: state)
            } else if state.armedTool == .hsl {
                // 8-band HSL panel replaces the drag bar (#274): HSL has
                // 24 sub-params and no single primary field, so the band
                // chips + three per-band sliders are its control surface.
                HSLSection(state: state)
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
                // Layer list + per-mask sliders replace the drag bar
                // (#3275): a mask writes `model.localAdjustments`, not a
                // scalar field, so it has no primary value for the drag bar
                // to drive — same swap as Tone Curve / Film / Lens.
                //
                // iPhone mounts THIS bar, never `MobileControlBar` (see
                // `EditorView`'s `if isIPhone` branch), so omitting the case
                // here left the Mask tool arming with no control surface at
                // all: the dock entry highlighted and the panel never
                // appeared.
                // Bounded + scrollable, unlike the other panels above: they
                // are a few rows tall, while this one stacks a layer list on
                // ELEVEN sliders. Left to size itself it took ~80% of the
                // phone screen and squeezed the canvas to a sliver — you
                // could not see the thing you were masking.
                ScrollView {
                    MaskPanel(state: state)
                }
                .frame(maxHeight: 300)
                .padding(.horizontal, 24)
                .padding(.vertical, 7)
            } else {
                DragBar(state: state)
                    .padding(.vertical, 7)
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
        .accessibilityIdentifier("editor-iphone-legacy-controls")
    }
}
