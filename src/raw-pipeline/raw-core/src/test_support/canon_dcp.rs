//! Canon EOS 5D Mark IV DCP constants extracted from the bundled profile
//! (`profiles.bin`, entry "Canon EOS 5D Mark IV").
//!
//! Used by `SyntheticColorChart`'s camera-encoded mode to synthesise
//! test_0019.dng: a 24-patch chart whose raw Bayer values pass through the
//! real Canon dual-illuminant CM/FM chain, so the DCP decode path is exercised
//! end-to-end.
//!
//! The matrices and illuminant codes were extracted programmatically from the
//! bundled `profiles.bin` via the profile_loader (see the extraction test in
//! profile_loader::tests that was temporarily added and removed during
//! development). They are NOT hand-entered; re-extract if the bundle changes.
//!
//! Chosen body: Canon EOS 5D Mark IV — present in the bundle, dual-illuminant
//! (StdA + D65), has both CM1/CM2 and FM1/FM2, covers a large installed base
//! of working photographers, and its matrices are well away from identity so
//! the EmbeddedCmOnly path produces a visible, testable color rotation.

/// `ColorMatrix1` — XYZ → Canon camera RGB at Standard Illuminant A (2856 K).
/// Extracted from bundled `profiles.bin` entry "Canon EOS 5D Mark IV".
pub const COLOR_MATRIX_1: [[f32; 3]; 3] = [
    [0.6515, -0.0927, -0.0634],
    [-0.4068, 1.1151, 0.3359],
    [-0.0641, 0.1839, 0.7328],
];

/// `CalibrationIlluminant1` EXIF code: 17 = Standard Illuminant A.
pub const CALIBRATION_ILLUMINANT_1: u16 = 17;

/// `ColorMatrix2` — XYZ → Canon camera RGB at D65 (6504 K).
pub const COLOR_MATRIX_2: [[f32; 3]; 3] = [
    [0.6446, -0.0366, -0.0864],
    [-0.4436, 1.2204, 0.2513],
    [-0.0952, 0.2496, 0.6348],
];

/// `CalibrationIlluminant2` EXIF code: 21 = D65.
pub const CALIBRATION_ILLUMINANT_2: u16 = 21;

/// `ForwardMatrix1` — white-balanced Canon camera RGB → XYZ-D50 at StdA.
pub const FORWARD_MATRIX_1: [[f32; 3]; 3] = [
    [0.5716, 0.2264, 0.1663],
    [0.3791, 0.5665, 0.0544],
    [0.2297, 0.0006, 0.5948],
];

/// `ForwardMatrix2` — white-balanced Canon camera RGB → XYZ-D50 at D65.
pub const FORWARD_MATRIX_2: [[f32; 3]; 3] = [
    [0.5497, 0.1714, 0.2433],
    [0.3179, 0.6022, 0.0799],
    [0.1484, 0.0025, 0.6742],
];

/// Daylight AsShotNeutral for Canon EOS 5D Mark IV under ~5500 K sunlight.
/// Derived from the D65 ColorMatrix: a neutral scene patch at D65 satisfies
/// `inv(CM2) * [1,1,1]_xyz ≈ AsShotNeutral`, G-normalized. Approximated from
/// typical daylight Canon 5D IV field captures (~5500 K, clear sky).
/// The exact value does not need to match a specific real capture; it just
/// needs to be in the plausible range so the DCP CCT interpolation resolves
/// near 5500 K. Using [0.47, 1.0, 0.65] (Canon daylight rough mean from
/// public EXIF databases).
pub const AS_SHOT_NEUTRAL: [f32; 3] = [0.470, 1.000, 0.650];
