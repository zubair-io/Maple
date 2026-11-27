//! Airport 2 design tokens: the one design system Maple and the new Just
//! Maple client share (docs/design/airport/README.md).
//!
//! Values come from the One app prototype of 27 November 2026 and match
//! `Airport 2.sketch`. `tools/codegen.sh` emits them to Swift (MapleUI),
//! TypeScript and SCSS custom properties. The older `ui_tokens` set stays
//! as it is until each screen moves to Airport.

pub struct AirportTheme {
    pub name: &'static str,
    pub base: &'static str,
    pub side: &'static str,
    pub raised: &'static str,
    pub float: &'static str,
    pub photo: &'static str,
    pub selected: &'static str,
    pub line: &'static str,
    pub ink: &'static str,
    pub button: &'static str,
    pub on_button: &'static str,
    pub active: &'static str,
    pub changed: &'static str,
    pub done: &'static str,
    pub shadow: &'static str,
}

/// Dark is the default: Maple's own warm-stone palette.
pub const AIRPORT_THEMES: &[AirportTheme] = &[
    AirportTheme {
        name: "dark",
        base: "#1c1917",
        side: "#211e1b",
        raised: "#262524",
        float: "#312c27",
        photo: "#141210",
        selected: "#40271f",
        line: "#39342f",
        ink: "#dddad8",
        button: "#dddad8",
        on_button: "#1c1917",
        active: "#e2574c",
        changed: "#e0a93c",
        done: "#4fb37a",
        shadow: "0 16px 40px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.07)",
    },
    AirportTheme {
        name: "light",
        base: "#ececec",
        side: "#e4e4e4",
        raised: "#f6f6f6",
        float: "#fbfbfb",
        photo: "#8a8a8a",
        selected: "#f0d9d3",
        line: "#d2d2d2",
        ink: "#141414",
        button: "#141414",
        on_button: "#f6f6f6",
        active: "#a8361f",
        changed: "#8a5a12",
        done: "#276b44",
        shadow: "0 12px 32px rgba(20, 20, 20, 0.16), 0 0 0 1px rgba(20, 20, 20, 0.08)",
    },
];

/// Selection ring, focus ring and the current filmstrip frame, in both themes.
pub const AIRPORT_MARKER: &str = "#c4493a";

/// One ink, four strengths. ink.4 is for disabled text and decoration only.
pub const AIRPORT_INK_STEPS: &[(&str, f64)] = &[
    ("ink_1", 1.0),
    ("ink_2", 0.76),
    ("ink_3", 0.64),
    ("ink_4", 0.32),
];

pub struct AirportTypeRole {
    pub name: &'static str,
    pub family: &'static str,
    pub weight: u16,
    pub size: u16,
    pub line_height: u16,
    /// Letter spacing in em.
    pub tracking: f64,
    pub uppercase: bool,
}

const fn role(
    name: &'static str,
    family: &'static str,
    weight: u16,
    size: u16,
    line_height: u16,
    tracking: f64,
) -> AirportTypeRole {
    AirportTypeRole {
        name,
        family,
        weight,
        size,
        line_height,
        tracking,
        uppercase: false,
    }
}

pub const AIRPORT_TYPE: &[AirportTypeRole] = &[
    role("display", "Lato", 300, 64, 68, -0.015),
    role("display_s", "Lato", 300, 40, 44, -0.01),
    role("title", "Lato", 300, 28, 34, 0.0),
    role("heading", "Lato", 400, 20, 26, 0.0),
    role("body", "Lato", 400, 17, 26, 0.0),
    role("callout", "Lato", 400, 15, 21, 0.0),
    role("label", "Lato", 700, 13, 16, 0.0),
    role("caption", "Lato", 400, 13, 18, 0.0),
    AirportTypeRole {
        uppercase: true,
        ..role("caps", "Lato", 900, 11, 14, 0.12)
    },
    role("value", "JetBrains Mono", 500, 13, 16, 0.0),
];

pub const AIRPORT_SPACE: &[u16] = &[4, 8, 12, 16, 24, 32, 48, 64, 96];

pub const AIRPORT_RADIUS: &[(&str, u16)] =
    &[("photo", 0), ("control", 8), ("panel", 14), ("pill", 999)];

pub const AIRPORT_TARGET: u16 = 44;

pub const AIRPORT_MOTION: &[(&str, u32, &str)] = &[
    ("tick", 90, "cubic-bezier(0.2, 0, 0, 1)"),
    ("move", 220, "cubic-bezier(0.2, 0, 0, 1)"),
    ("travel", 360, "cubic-bezier(0.3, 0, 0, 1)"),
    ("reduce", 120, "linear"),
];

/// Panorama widths in points: the folder list, one grid column and its gap,
/// the gap between cards, then each kind of card.
pub const AIRPORT_PANORAMA: &[(&str, u16)] = &[
    ("folder_list", 252),
    ("grid_column", 166),
    ("grid_gap", 2),
    ("card_gap", 49),
    ("card_photo", 600),
    ("card_memo", 620),
    ("card_chat", 480),
    ("card_todo", 440),
    ("card_data", 440),
    ("card_thread", 400),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(hex: &str) -> [f64; 3] {
        let channel =
            |i: usize| f64::from(u8::from_str_radix(&hex[1 + i * 2..3 + i * 2], 16).unwrap());
        [channel(0), channel(1), channel(2)]
    }

    fn luminance(c: [f64; 3]) -> f64 {
        let lin = |v: f64| {
            let s = v / 255.0;
            if s <= 0.03928 {
                s / 12.92
            } else {
                ((s + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
    }

    fn contrast(fg: [f64; 3], bg: [f64; 3]) -> f64 {
        let (a, b) = (luminance(fg), luminance(bg));
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    fn over(ink: [f64; 3], bg: [f64; 3], alpha: f64) -> [f64; 3] {
        [0, 1, 2].map(|i| (ink[i] * alpha + bg[i] * (1.0 - alpha)).round())
    }

    #[test]
    fn every_colour_is_a_lowercase_six_digit_hex() {
        for t in AIRPORT_THEMES {
            for v in [
                t.base,
                t.side,
                t.raised,
                t.float,
                t.photo,
                t.selected,
                t.line,
                t.ink,
                t.button,
                t.on_button,
                t.active,
                t.changed,
                t.done,
                AIRPORT_MARKER,
            ] {
                assert!(v.len() == 7 && v.starts_with('#'), "{v}");
                assert_eq!(v, v.to_lowercase(), "{v}");
            }
        }
    }

    #[test]
    fn readable_ink_steps_pass_aa_on_every_surface() {
        for t in AIRPORT_THEMES {
            for surface in [t.base, t.side, t.raised, t.float, t.selected] {
                for &(step, alpha) in &AIRPORT_INK_STEPS[..3] {
                    let ratio = contrast(over(rgb(t.ink), rgb(surface), alpha), rgb(surface));
                    assert!(ratio >= 4.5, "{} {step} on {surface}: {ratio:.2}", t.name);
                }
            }
        }
    }

    #[test]
    fn state_colours_pass_aa_as_text_on_the_base() {
        for t in AIRPORT_THEMES {
            for state in [t.active, t.changed, t.done] {
                let ratio = contrast(rgb(state), rgb(t.base));
                assert!(ratio >= 4.5, "{} {state}: {ratio:.2}", t.name);
            }
        }
    }

    #[test]
    fn names_are_unique_and_dark_comes_first() {
        assert_eq!(AIRPORT_THEMES[0].name, "dark");
        let mut names: Vec<&str> = AIRPORT_TYPE.iter().map(|r| r.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), AIRPORT_TYPE.len());
    }

    #[test]
    fn display_roles_use_light_never_thin() {
        assert!(AIRPORT_TYPE.iter().all(|r| r.weight >= 300));
    }

    #[test]
    fn space_scale_rises() {
        assert!(AIRPORT_SPACE.windows(2).all(|w| w[0] < w[1]));
    }
}
