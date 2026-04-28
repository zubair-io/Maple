//! Photometric compensation between panorama frames.
//!
//! Geometric alignment (warping) gets each pixel into the right position;
//! photometric compensation makes them BRIGHTNESS-match so seams aren't
//! visible. Currently: per-image gain only. Per-image vignetting + lens
//! falloff is a follow-up.

pub mod gain;
