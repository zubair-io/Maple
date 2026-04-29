//! Hasselblad L3D-100c DCP constants extracted from test_0000.DNG.
//! Re-run `examples/extract-dcp.rs` and paste the output here when the
//! source DNG changes.

// ColorMatrix1 — StdA calibration illuminant (CalibrationIlluminant1 = 17).
pub const COLOR_MATRIX_1: [[f32; 3]; 3] = [
    [0.936800, -0.354300, -0.092700],
    [-0.841900, 1.875800, 0.137600],
    [-0.004200, 0.056900, 0.961300],
];

/// CalibrationIlluminant1 EXIF code: 17 = Standard Illuminant A.
pub const CALIBRATION_ILLUMINANT_1: u16 = 17;

// ColorMatrix2 — D65 calibration illuminant (CalibrationIlluminant2 = 21).
pub const COLOR_MATRIX_2: [[f32; 3]; 3] = [
    [0.559100, -0.115000, -0.079400],
    [-0.755900, 1.641400, 0.070700],
    [-0.029800, 0.149000, 0.521300],
];

/// CalibrationIlluminant2 EXIF code: 21 = D65.
pub const CALIBRATION_ILLUMINANT_2: u16 = 21;

pub const AS_SHOT_NEUTRAL: [f32; 3] = [0.372330, 1.000000, 0.675685];
