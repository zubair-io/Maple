// Validation and custom-basis transpose oracle. Production uses raw-core literals.
fn basis(k: u32, n: u32) -> f32 { return p.basis[k * 2u + n / 4u][n % 4u]; }
