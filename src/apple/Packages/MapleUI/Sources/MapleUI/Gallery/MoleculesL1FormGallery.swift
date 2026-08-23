// MoleculesL1FormGallery.swift — Molecules L1 tab, catalog §2.1 Form &
// entry: Form Field, Inline Rename Field, Search Bar, Slider, Living
// Slider, Drag Bar, Color Wheel, 2-D Pad.

import SwiftUI

extension MoleculesL1GallerySection {
    var formFieldCard: some View {
        GallerySpecimenCard(name: "Form Field", purpose: "Label + control + help/error", builtFrom: "Text, Input, Text") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiFormField(label: "Display name", value: .constant("Ada Lovelace"), help: "Shown on shared albums")
                MuiFormField(label: "Email", value: .constant("not-an-email"), error: "Enter a valid email address")
            }
        }
    }

    var inlineRenameFieldCard: some View {
        GallerySpecimenCard(name: "Inline Rename Field", purpose: "Edit-in-place name", builtFrom: "Input, Text") {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiInlineRenameField(value: .constant("IMG_0042.dng"))
                MuiInlineRenameField(value: .constant("Locked album"), disabled: true)
            }
        }
    }

    var searchBarCard: some View {
        GallerySpecimenCard(name: "Search Bar", purpose: "Query pill with clear", builtFrom: "Icon, Input, Button") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiSearchBar(value: .constant(""), placeholder: "Search photos…")
                MuiSearchBar(value: .constant("sunset"), actionLabel: "Filters", actionIcon: "line.3.horizontal.decrease")
            }
        }
    }

    var sliderCard: some View {
        GallerySpecimenCard(name: "Slider", purpose: "Labeled slider with numeric readout", builtFrom: "Text, Input") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiSlider(label: "Exposure", value: .constant(0.3), range: -2...2, step: 0.1)
                MuiSlider(label: "Locked", value: .constant(50), disabled: true)
            }
        }
    }

    var livingSliderCard: some View {
        GallerySpecimenCard(name: "Living Slider", purpose: "Gradient-track slider", builtFrom: "Text, Input") {
            MuiLivingSlider(
                label: "Temp",
                value: .constant(6500),
                range: 2000...12000,
                step: 50,
                gradientColors: [.blue, .white, .orange],
                unit: "K"
            )
        }
    }

    var dragBarCard: some View {
        GallerySpecimenCard(name: "Drag Bar", purpose: "Tick-marked scrub control", builtFrom: "Text") {
            VStack(spacing: MuiTokens.spacingSm) {
                MuiDragBar(label: "Straighten", value: .constant(0))
                MuiDragBar(value: .constant(35))
            }
        }
    }

    var colorWheelCard: some View {
        GallerySpecimenCard(name: "Color Wheel", purpose: "Draggable hue/saturation puck", builtFrom: "(none — primitive plot)") {
            MuiColorWheel(value: .constant(MuiColorWheelValue(hue: 210, saturation: 40)))
        }
    }

    var pad2DCard: some View {
        GallerySpecimenCard(name: "2-D Pad", purpose: "Two-axis draggable puck", builtFrom: "(none — primitive plot)") {
            MuiPad2D(value: .constant(MuiPad2DValue(x: 0.2, y: -0.3)))
        }
    }
}
