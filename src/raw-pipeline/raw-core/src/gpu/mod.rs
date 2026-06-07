//! GPU compute spike (epic #925, P0). Feature-gated behind `gpu` (OFF by
//! default). Proves one stage (exposure: `rgb *= 2^ev`) runs GPU-resident via
//! wgpu+WGSL and matches the Rust CPU oracle within 1e-4. The CPU path in
//! `raw-core` stays the parity oracle and fallback.
