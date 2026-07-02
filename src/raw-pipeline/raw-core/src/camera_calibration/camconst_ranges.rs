// SPDX-License-Identifier: GPL-3.0-or-later
//
// ****************************************************************************
// AUTO-GENERATED — DO NOT EDIT BY HAND.
// Regenerate with: python3 src/scripts/port_camconst.py
//
// Source: RawTherapee camconst.json, RT 5.12.
// Source path at port time: /Applications/RawTherapee.app/Contents/Resources/share/camconst.json
// Upstream reference:
//   https://github.com/Beep6581/RawTherapee/blob/dev/rtengine/camconst.json
// Attribution and licensing: docs/licenses/rawtherapee-attribution.md.
//
// The numerical values below are sensor measurements (facts). Their
// organization into this Rust compilation is Maple's work. Each body entry
// cites the specific RT camconst.json line it was derived from.
// ****************************************************************************

#[allow(unused_imports)]
use super::{BlackLevels, IsoBucket, Linearization, WhiteLevels};

#[allow(clippy::type_complexity)]
pub(super) struct CamconstEntry {
    pub make: &'static str,
    pub model: &'static str,
    pub data: Linearization,
}

pub(super) static CAMCONST_ENTRIES: &[CamconstEntry] = &[
    // ── Canon · Canon EOS 5DS R ──
    // RT camconst.json source entry:
    //     {
    //       "make_model": [
    //         "Canon EOS 5DS R",
    //         "Canon EOS 5DS"
    //       ],
    //       "dcraw_matrix": [
    //         6250,
    //         -711,
    //         -808,
    //         -5153,
    //         12794,
    //         2636,
    //         -1249,
    //         2198,
    //         5610
    //       ],
    //       "raw_crop": [
    //         192,
    //         96,
    //         8696,
    //         5800
    //       ],
    //       "masked_areas": [
    //         100,
    //         40,
    //         5892,
    //         158
    //       ],
    //       "ranges": {
    //         "white": [
    //           {
    //             "iso": [
    //               50,
    //               100
    //             ],
    //             "levels": 14650
    //           },
    //           {
    //             "iso": [
    //               160,
    //     ... (truncated)
    CamconstEntry {
        make: "Canon",
        model: "Canon EOS 5DS R",
        data: Linearization {
            black: &[],
            white: &[
                IsoBucket {
                    iso_range: (50, 100),
                    value: WhiteLevels::Single(14650),
                }, // iso=[50, 100]
                IsoBucket {
                    iso_range: (160, 5000),
                    value: WhiteLevels::Single(15280),
                }, // iso=[160, 320, 640, 1250, 2500, 5000]
                IsoBucket {
                    iso_range: (125, 2000),
                    value: WhiteLevels::Single(15280),
                }, // iso=[125, 200, 250, 400, 500, 800, 1000, 1600, 2000]
                IsoBucket {
                    iso_range: (3200, 25600),
                    value: WhiteLevels::Single(15100),
                }, // iso=[3200, 4000, 6400, 8000, 10000, 12800, 16000, 20000, 25600]
            ],
        },
    },
];
