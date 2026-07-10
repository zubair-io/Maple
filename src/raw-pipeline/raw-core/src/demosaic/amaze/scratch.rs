//! Per-tile working state for the tiled AMaZE kernel.
//!
//! Upstream (RawTherapee `amaze_demosaic_RT.cc`, darktable `amaze.cc`)
//! processes the frame in `ts × ts` tiles so every intermediate plane is a
//! small per-thread buffer that stays cache-resident, and tiles run in
//! parallel. This module holds that per-tile state plus the tile fill:
//! copying the mosaic window into the tile buffer, with a parity-preserving
//! mirror reflection wherever the 16-px halo hangs past the frame edge, so
//! frame-border pixels get the full AMaZE treatment instead of a fallback.

use crate::image::CfaPattern;

/// Tile edge, matching upstream `AMAZETS` (fastest on modern hardware).
pub(super) const TS: usize = 160;
/// Half tile size — length of one row of half-resolution (per-CFA-pair) cells.
pub(super) const TSH: usize = TS / 2;
/// Output rows/columns each tile owns: the tile minus a 16-px halo per side.
/// Tiles step by this amount, so interiors are disjoint and cover the frame.
pub(super) const BAND: usize = TS - 32;

/// Tile placement. `top`/`left` may be negative: the first tile row/column
/// starts at −16 so its halo hangs over the frame edge and every frame pixel
/// (including borders) falls inside some tile's `[16, dim−16)` interior.
/// Both are always even, so tile-local CFA parity equals global parity and
/// `pattern.color_at(cc, rr)` on tile-local coordinates is correct.
pub(super) struct Tile {
    pub top: isize,
    pub left: isize,
    /// Tile height in rows (≤ `TS`; ≥ 33 for any frame ≥ 17 px).
    pub rr1: usize,
    /// Tile width in columns (≤ `TS`; ≥ 33 for any frame ≥ 17 px).
    pub cc1: usize,
}

/// All per-tile planes. ~2 MB total — allocated once per band task and
/// reused across that band's tiles (see `reset`).
pub(super) struct Scratch {
    // Full-resolution planes (TS × TS, indexed `rr * TS + cc`).
    pub cfa: Vec<f32>,
    pub rgbgreen: Vec<f32>,
    pub dirwts0: Vec<f32>,
    pub dirwts1: Vec<f32>,
    pub delhvsqsum: Vec<f32>,
    pub vcd: Vec<f32>,
    pub hcd: Vec<f32>,
    pub vcdalt: Vec<f32>,
    pub hcdalt: Vec<f32>,
    pub dgintv: Vec<f32>,
    pub dginth: Vec<f32>,
    pub cddiffsq: Vec<f32>,
    // Half-resolution planes (one cell per CFA pair, indexed `i >> 1`; see
    // the module docs in `mod.rs` for why this aliasing is load-bearing).
    pub hvwt: Vec<f32>,
    pub dgrb0: Vec<f32>, // G − R field
    pub dgrb1: Vec<f32>, // G − B field
    pub dgrb2h: Vec<f32>,
    pub dgrb2v: Vec<f32>,
    pub delp: Vec<f32>,
    pub delm: Vec<f32>,
    pub dgrbsq1p: Vec<f32>,
    pub dgrbsq1m: Vec<f32>,
    pub rbm: Vec<f32>,
    pub rbp: Vec<f32>,
    pub pmwt: Vec<f32>,
    pub rbint: Vec<f32>,
    pub nyquist: Vec<u8>,
    pub nyquist2: Vec<u8>,
}

impl Scratch {
    pub fn new() -> Self {
        let full = || vec![0.0_f32; TS * TS];
        let half = || vec![0.0_f32; TS * TSH];
        Scratch {
            cfa: full(),
            rgbgreen: full(),
            dirwts0: full(),
            dirwts1: full(),
            delhvsqsum: full(),
            vcd: full(),
            hcd: full(),
            vcdalt: full(),
            hcdalt: full(),
            dgintv: full(),
            dginth: full(),
            cddiffsq: full(),
            hvwt: vec![0.5_f32; TS * TSH],
            dgrb0: half(),
            dgrb1: half(),
            dgrb2h: half(),
            dgrb2v: half(),
            delp: half(),
            delm: half(),
            dgrbsq1p: half(),
            dgrbsq1m: half(),
            rbm: half(),
            rbp: half(),
            pmwt: half(),
            rbint: half(),
            nyquist: vec![0_u8; TS * TSH],
            nyquist2: vec![0_u8; TS * TSH],
        }
    }

    /// Clear state carried from the previous tile. Upstream leaves most
    /// buffers dirty and relies on read-ranges ⊆ write-ranges; where that
    /// doesn't hold (e.g. the ±m3 sharpening taps just outside the split
    /// range, `Dgrb2` under the Nyquist gaussian) it reads stale values it
    /// treats as noise. Zeroing everything instead is deterministic, matches
    /// the first-tile (calloc) behaviour, and costs ~2 MB of memset per tile
    /// — negligible against the tile's arithmetic.
    pub fn reset(&mut self) {
        // dirwts keeps the EPS floor its consumers divide by.
        self.dirwts0.fill(1e-5);
        self.dirwts1.fill(1e-5);
        self.hvwt.fill(0.5);
        for buf in [
            &mut self.cfa,
            &mut self.rgbgreen,
            &mut self.delhvsqsum,
            &mut self.vcd,
            &mut self.hcd,
            &mut self.vcdalt,
            &mut self.hcdalt,
            &mut self.dgintv,
            &mut self.dginth,
            &mut self.cddiffsq,
        ] {
            buf.fill(0.0);
        }
        for buf in [
            &mut self.dgrb0,
            &mut self.dgrb1,
            &mut self.dgrb2h,
            &mut self.dgrb2v,
            &mut self.delp,
            &mut self.delm,
            &mut self.dgrbsq1p,
            &mut self.dgrbsq1m,
            &mut self.rbm,
            &mut self.rbp,
            &mut self.pmwt,
            &mut self.rbint,
        ] {
            buf.fill(0.0);
        }
        self.nyquist.fill(0);
        self.nyquist2.fill(0);
    }
}

/// Neighbour index at signed full-resolution offset `d` from `i`.
#[inline(always)]
pub(super) fn at(i: usize, d: isize) -> usize {
    (i as isize + d) as usize
}

/// Half-resolution cell of the full-resolution index `i + d` (upstream
/// `arr[(indx + d) >> 1]`).
#[inline(always)]
pub(super) fn hf(i: usize, d: isize) -> usize {
    ((i as isize + d) as usize) >> 1
}

/// Branch-light median of three (upstream `median()`).
#[inline(always)]
pub(super) fn median3(a: f32, b: f32, c: f32) -> f32 {
    a.min(b).max(a.max(b).min(c))
}

/// The 2×2 phase of the Red site — upstream `(ey, ex)`.
pub(super) fn red_phase(pattern: CfaPattern) -> (u32, u32) {
    for yy in 0..2u32 {
        for xx in 0..2u32 {
            if pattern.color_at(xx, yy) as usize == 0 {
                return (xx, yy);
            }
        }
    }
    (0, 0)
}

/// Copy the tile's mosaic window out of the full-frame `cfa_flat`, mirroring
/// (parity-preserving, about the frame edge) wherever the halo hangs outside
/// the frame. Seeds `rgbgreen = cfa` — G sites keep the raw sample; R/B
/// sites are overwritten by the chroma stages. Upstream fills corners from
/// fixed rows 17..32 (a quirk that requires ≥ 33-px frames); we mirror both
/// axes consistently, which stays in-bounds for every frame ≥ 17 px.
pub(super) fn fill_tile(s: &mut Scratch, t: &Tile, cfa_flat: &[f32], w: usize, h: usize) {
    let rrmin = if t.top < 0 { 16 } else { 0 };
    let ccmin = if t.left < 0 { 16 } else { 0 };
    let rrmax = if t.top + t.rr1 as isize > h as isize {
        (h as isize - t.top) as usize
    } else {
        t.rr1
    };
    let ccmax = if t.left + t.cc1 as isize > w as isize {
        (w as isize - t.left) as usize
    } else {
        t.cc1
    };

    // Mirror of the out-of-frame coordinate about the frame edge, keeping
    // CFA parity (reflection about row/col 0 or dim−1 moves by an even step).
    let mirror_top = |rr: usize| (-(t.top + rr as isize)) as usize; // global row
    let mirror_left = |cc: usize| (-(t.left + cc as isize)) as usize; // global col

    let mut set = |rr: usize, cc: usize, grow: usize, gcol: usize| {
        let v = cfa_flat[grow * w + gcol];
        s.cfa[rr * TS + cc] = v;
        s.rgbgreen[rr * TS + cc] = v;
    };

    // Inner (in-frame) part.
    for rr in rrmin..rrmax {
        let grow = (t.top + rr as isize) as usize;
        for cc in ccmin..ccmax {
            set(rr, cc, grow, (t.left + cc as isize) as usize);
        }
    }
    // Top halo.
    if rrmin > 0 {
        for rr in 0..16 {
            let grow = mirror_top(rr);
            for cc in ccmin..ccmax {
                set(rr, cc, grow, (t.left + cc as isize) as usize);
            }
        }
    }
    // Bottom halo (clamped: the mirror never exceeds the tile).
    if rrmax < t.rr1 {
        for rr in 0..16.min(t.rr1 - rrmax) {
            let grow = h - rr - 2;
            for cc in ccmin..ccmax {
                set(rrmax + rr, cc, grow, (t.left + cc as isize) as usize);
            }
        }
    }
    // Left halo.
    if ccmin > 0 {
        for rr in rrmin..rrmax {
            let grow = (t.top + rr as isize) as usize;
            for cc in 0..16 {
                set(rr, cc, grow, mirror_left(cc));
            }
        }
    }
    // Right halo (clamped as above).
    if ccmax < t.cc1 {
        for rr in rrmin..rrmax {
            let grow = (t.top + rr as isize) as usize;
            for cc in 0..16.min(t.cc1 - ccmax) {
                set(rr, ccmax + cc, grow, w - cc - 2);
            }
        }
    }
    // Corners: mirror both axes.
    if rrmin > 0 && ccmin > 0 {
        for rr in 0..16 {
            for cc in 0..16 {
                set(rr, cc, mirror_top(rr), mirror_left(cc));
            }
        }
    }
    if rrmax < t.rr1 && ccmax < t.cc1 {
        for rr in 0..16.min(t.rr1 - rrmax) {
            for cc in 0..16.min(t.cc1 - ccmax) {
                set(rrmax + rr, ccmax + cc, h - rr - 2, w - cc - 2);
            }
        }
    }
    if rrmin > 0 && ccmax < t.cc1 {
        for rr in 0..16 {
            for cc in 0..16.min(t.cc1 - ccmax) {
                set(rr, ccmax + cc, mirror_top(rr), w - cc - 2);
            }
        }
    }
    if rrmax < t.rr1 && ccmin > 0 {
        for rr in 0..16.min(t.rr1 - rrmax) {
            for cc in 0..16 {
                set(rrmax + rr, cc, h - rr - 2, mirror_left(cc));
            }
        }
    }
}
