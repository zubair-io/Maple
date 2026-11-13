//! Canonical editor track palettes, moved unchanged from iOS GradientCatalog (#4662).
//! Display-referred sRGB colors; these do not participate in image processing.

pub struct SliderGradient {
    pub name: &'static str,
    pub stops: &'static [(f32, u32)],
}

pub const SLIDER_GRADIENTS: &[SliderGradient] = &[
    SliderGradient {
        name: "exposure",
        stops: &[(0.0, 0x0B0A08), (1.0, 0xF2EFE9)],
    },
    SliderGradient {
        name: "brightness",
        stops: &[(0.0, 0x6E675E), (1.0, 0xF2EFE9)],
    },
    SliderGradient {
        name: "contrast",
        stops: &[(0.0, 0x6E675E), (1.0, 0xF2EFE9)],
    },
    SliderGradient {
        name: "highlights",
        stops: &[(0.0, 0x9B958C), (1.0, 0xFFFFFF)],
    },
    SliderGradient {
        name: "shadows",
        stops: &[(0.0, 0x000000), (1.0, 0x9B958C)],
    },
    SliderGradient {
        name: "whites",
        stops: &[(0.0, 0xD8D4CC), (1.0, 0xFFFFFF)],
    },
    SliderGradient {
        name: "blacks",
        stops: &[(0.0, 0x000000), (1.0, 0x3A352F)],
    },
    SliderGradient {
        name: "temp",
        stops: &[(0.0, 0x3B6FB0), (1.0, 0xE8A33D)],
    },
    SliderGradient {
        name: "tint",
        stops: &[(0.0, 0x3FAE6A), (1.0, 0xC64FB0)],
    },
    SliderGradient {
        name: "vibrance",
        stops: &[(0.0, 0x6E675E), (1.0, 0x4A9FC4)],
    },
    SliderGradient {
        name: "saturation",
        stops: &[(0.0, 0x6E675E), (1.0, 0xC4493A)],
    },
    SliderGradient {
        name: "hsl",
        stops: &[
            (0.0, 0xC4493A),
            (0.33, 0xE8A33D),
            (0.66, 0x3FAE6A),
            (1.0, 0x3B6FB0),
        ],
    },
    SliderGradient {
        name: "clarity",
        stops: &[(0.0, 0x4A443B), (1.0, 0xA8A097)],
    },
    SliderGradient {
        name: "texture",
        stops: &[(0.0, 0x4A443B), (1.0, 0xA8A097)],
    },
    SliderGradient {
        name: "dehaze",
        stops: &[(0.0, 0x4A443B), (1.0, 0xA8A097)],
    },
    SliderGradient {
        name: "vignette",
        stops: &[(0.0, 0x08070A), (0.5, 0x6E675E), (1.0, 0x08070A)],
    },
    SliderGradient {
        name: "grain",
        stops: &[(0.0, 0x1D1B17), (1.0, 0xA8A097)],
    },
    SliderGradient {
        name: "sharpen",
        stops: &[(0.0, 0x4A443B), (1.0, 0xF2EFE9)],
    },
    SliderGradient {
        name: "noise",
        stops: &[(0.0, 0x4A443B), (1.0, 0xF2EFE9)],
    },
    SliderGradient {
        name: "colorNR",
        stops: &[(0.0, 0x4A443B), (1.0, 0xF2EFE9)],
    },
    SliderGradient {
        name: "captureSharpen",
        stops: &[(0.0, 0x4A443B), (1.0, 0xF2EFE9)],
    },
    SliderGradient {
        name: "captureSigma",
        stops: &[(0.0, 0x4A443B), (1.0, 0xF2EFE9)],
    },
    SliderGradient {
        name: "toneCurve",
        stops: &[(0.0, 0x000000), (1.0, 0xFFFFFF)],
    },
];
